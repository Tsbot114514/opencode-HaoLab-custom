package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

const remotePort = "41642"

type command struct {
	ID       int64    `json:"id"`
	Command  string   `json:"command"`
	Projects []string `json:"projects,omitempty"`
	URL      string   `json:"url,omitempty"`
	Username string   `json:"username,omitempty"`
	Password string   `json:"password,omitempty"`
	Share    string   `json:"share,omitempty"`
	AuthKey  string   `json:"authKey,omitempty"`
}

type connection struct {
	Host     string `json:"host"`
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type result struct {
	Enabled    bool        `json:"enabled"`
	Online     bool        `json:"online"`
	AuthURL    string      `json:"authUrl,omitempty"`
	LoginError string      `json:"loginError,omitempty"`
	HasAuthKey bool        `json:"hasAuthKey"`
	AutoJoin   bool        `json:"autoJoin"`
	Share      string      `json:"share,omitempty"`
	Connection *connection `json:"connection,omitempty"`
}

type response struct {
	ID     int64   `json:"id"`
	Result *result `json:"result,omitempty"`
	Error  string  `json:"error,omitempty"`
}

type invitation struct {
	Version int    `json:"version"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	AuthKey string `json:"authKey,omitempty"`
}

type helper struct {
	mu          sync.Mutex
	stateDir    string
	node        *tsnet.Server
	server      *http.Server
	serverConn  *trackedListener
	bridge      *http.Server
	bridgeConn  *trackedListener
	sidecar     *url.URL
	sidecarUser string
	sidecarPass string
	shareToken  string
	projects    []string
	authKey     string
	localSecret string
	peer        *invitation
	bridgeAddr  string
	authURL     string
	loginError  string
	lastLogin   time.Time
	loginSince  time.Time
	watchCancel context.CancelFunc
	watcher     *local.IPNBusWatcher
	watchDone   chan struct{}
	authReady   chan struct{}
}

func main() {
	dir := flag.String("state-dir", "", "private state directory")
	flag.Parse()
	if *dir == "" || flag.NArg() != 0 {
		os.Exit(2)
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		os.Exit(1)
	}
	if err := os.Chmod(*dir, 0700); err != nil {
		os.Exit(1)
	}
	h := &helper{stateDir: *dir}
	defer h.close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	lines := make(chan []byte)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			select {
			case lines <- append([]byte(nil), scanner.Bytes()...):
			case <-ctx.Done():
				return
			}
		}
	}()
	writer := bufio.NewWriter(os.Stdout)
	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-lines:
			if !ok {
				return
			}
			var cmd command
			if err := json.Unmarshal(line, &cmd); err != nil {
				_ = json.NewEncoder(writer).Encode(response{Error: "invalid command"})
			} else {
				out, err := h.execute(cmd)
				if err != nil {
					_ = json.NewEncoder(writer).Encode(response{ID: cmd.ID, Error: err.Error()})
				} else {
					_ = json.NewEncoder(writer).Encode(response{ID: cmd.ID, Result: out})
				}
			}
			if writer.Flush() != nil {
				return
			}
		}
	}
}

func (h *helper) execute(cmd command) (*result, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch cmd.Command {
	case "projects":
		if err := validateProjects(cmd.Projects); err != nil {
			return nil, err
		}
		h.projects = append(make([]string, 0, len(cmd.Projects)), cmd.Projects...)
	case "sidecar":
		u, err := parseSidecar(cmd.URL)
		if err != nil {
			return nil, err
		}
		h.sidecar, h.sidecarUser, h.sidecarPass = u, cmd.Username, cmd.Password
	case "auth-key":
		if !validAuthKey(cmd.AuthKey) {
			return nil, errors.New("invalid tailnet auth key")
		}
		h.authKey = cmd.AuthKey
	case "enable":
		if err := h.start(""); err != nil {
			return nil, err
		}
		if h.server == nil {
			if err := h.enable(); err != nil {
				return nil, err
			}
		}
	case "disable":
		if h.server != nil {
			_ = h.server.Close()
			h.serverConn.closeAll()
			h.server = nil
			h.serverConn = nil
		}
	case "connect":
		peer, err := parseShare(cmd.Share)
		if err != nil {
			return nil, err
		}
		if h.bridge != nil {
			return nil, errors.New("disconnect before connecting again")
		}
		if err := h.start(peer.AuthKey); err != nil {
			return nil, err
		}
		if err := h.connect(peer); err != nil {
			return nil, err
		}
	case "disconnect":
		if h.bridge != nil {
			_ = h.bridge.Close()
			h.bridgeConn.closeAll()
			h.bridge = nil
			h.bridgeConn = nil
			h.peer = nil
			h.bridgeAddr = ""
		}
	case "status":
	default:
		return nil, errors.New("unknown command")
	}
	out := h.status()
	if cmd.Command == "enable" && !out.Online && out.AuthURL == "" && h.authReady != nil {
		// The browser URL arrives asynchronously, but the enable reply is what opens it.
		h.mu.Unlock()
		select {
		case <-h.authReady:
		case <-h.watchDone:
		case <-time.After(6 * time.Second):
		}
		h.mu.Lock()
		out = h.status()
	}
	return out, nil
}

func validateProjects(projects []string) error {
	if len(projects) > 512 {
		return errors.New("invalid projects")
	}
	seen := make(map[string]bool, len(projects))
	for _, project := range projects {
		if !filepath.IsAbs(project) || seen[filepath.Clean(project)] {
			return errors.New("invalid projects")
		}
		seen[filepath.Clean(project)] = true
	}
	return nil
}

func (h *helper) start(authKey string) error {
	if h.node != nil {
		if authKey != "" {
			return h.joinWithAuthKey(authKey)
		}
		return nil
	}
	state := filepath.Join(h.stateDir, "tsnet")
	if err := os.MkdirAll(state, 0700); err != nil {
		return errors.New("unable to create tailnet state")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(state, 0700); err != nil {
			return errors.New("unable to protect tailnet state")
		}
	}
	_, stateErr := os.Stat(filepath.Join(state, "tailscaled.state"))
	s := &tsnet.Server{Dir: state, Hostname: "haolab-code", AuthKey: authKey, Ephemeral: false, Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	if err := s.Start(); err != nil {
		_ = s.Close()
		return errors.New("unable to start tailnet")
	}
	client, err := s.LocalClient()
	if err != nil {
		_ = s.Close()
		return errors.New("unable to access tailnet status")
	}
	ctx, cancel := context.WithCancel(context.Background())
	watcher, err := client.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		cancel()
		_ = s.Close()
		return errors.New("unable to watch tailnet login")
	}
	h.watchCancel, h.watcher, h.watchDone, h.authReady = cancel, watcher, make(chan struct{}), make(chan struct{})
	go func() {
		defer close(h.watchDone)
		defer watcher.Close()
		for {
			n, err := watcher.Next()
			if err != nil {
				return
			}
			h.mu.Lock()
			h.recordLogin(n)
			h.mu.Unlock()
		}
	}()
	h.node = s
	if authKey != "" && stateErr == nil {
		return h.joinWithAuthKey(authKey)
	}
	return nil
}

func (h *helper) joinWithAuthKey(authKey string) error {
	client, err := h.node.LocalClient()
	if err != nil {
		return errors.New("unable to access tailnet status")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	st, err := client.Status(ctx)
	cancel()
	if err != nil || st == nil {
		return errors.New("unable to read tailnet status")
	}
	if st.BackendState == "Running" {
		return nil
	}
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	err = client.Start(ctx, ipn.Options{AuthKey: authKey})
	cancel()
	if err != nil {
		return errors.New("unable to join tailnet with auth key")
	}
	return nil
}

func (h *helper) status() *result {
	out := &result{Enabled: h.server != nil, HasAuthKey: h.authKey != "", AutoJoin: h.peer != nil && h.peer.AuthKey != ""}
	if h.node != nil {
		client, err := h.node.LocalClient()
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			st, err := client.Status(ctx)
			cancel()
			if err == nil && st != nil {
				out.Online = st.BackendState == "Running"
				if !out.Online {
					out.AuthURL = st.AuthURL
					if out.AuthURL == "" && h.authURL == "" && h.loginSince.IsZero() {
						h.loginSince = time.Now()
					}
					if out.AuthURL == "" && h.authURL == "" && (h.peer == nil || h.peer.AuthKey == "") && shouldRetryLogin(st.BackendState, h.lastLogin, time.Now()) {
						h.lastLogin = time.Now()
						loginCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
						loginErr := client.StartLoginInteractive(loginCtx)
						cancel()
						if loginErr != nil {
							h.loginError = "获取组网授权链接失败，正在自动重试"
						} else {
							h.loginError = ""
						}
					}
					if out.AuthURL == "" && h.authURL == "" && h.loginError == "" && time.Since(h.loginSince) >= 30*time.Second {
						h.loginError = "组网尚未上线，请检查入网 Auth Key、管理员审批或网络连接"
						if h.peer == nil || h.peer.AuthKey == "" {
							h.loginError = "组网服务尚未返回授权链接，请检查系统代理或网络；正在自动重试"
						}
					}
				} else {
					h.loginSince = time.Time{}
				}
				if out.Online && out.Enabled && st.Self != nil && h.shareToken != "" && h.authKey != "" {
					host := strings.TrimSuffix(st.Self.DNSName, ".")
					if validTailnetHost(host) {
						share, _ := json.Marshal(invitation{Version: 2, Host: host, Port: 41642, Token: h.shareToken, AuthKey: h.authKey})
						out.Share = string(share)
					}
				}
			}
			if err != nil {
				h.loginError = "无法读取组网状态，正在自动重试"
			}
		} else {
			h.loginError = "无法访问组网状态，正在自动重试"
		}
	}
	if !out.Online && out.AuthURL == "" {
		out.AuthURL = h.authURL
		if out.AuthURL == "" {
			out.LoginError = h.loginError
		}
	}
	if h.peer != nil && h.peer.AuthKey != "" && !out.Online && out.AuthURL != "" {
		out.AuthURL = ""
		out.LoginError = "入网 Auth Key 未能授权此设备，请检查管理员审批或在 A 更新配对信息"
	}
	if h.peer != nil {
		out.Connection = &connection{Host: h.peer.Host, URL: "http://" + h.bridgeAddr, Username: "client", Password: h.localSecret}
	}
	return out
}

// recordLogin runs under h.mu; the login URL must never be persisted or logged.
func (h *helper) recordLogin(n ipn.Notify) {
	if n.State != nil && *n.State == ipn.Running {
		h.authURL = ""
		h.loginError = ""
		h.loginSince = time.Time{}
		return
	}
	if n.BrowseToURL != nil && *n.BrowseToURL != "" {
		h.authURL = *n.BrowseToURL
		h.loginError = ""
		h.loginSince = time.Time{}
		if h.authReady != nil {
			select {
			case <-h.authReady:
			default:
				close(h.authReady)
			}
		}
	}
}

func shouldRetryLogin(state string, last, now time.Time) bool {
	return (state == "NeedsLogin" || state == "NoState") && now.Sub(last) >= 5*time.Second
}

func (h *helper) enable() error {
	secret, err := loadSecret(filepath.Join(h.stateDir, "share.token"))
	if err != nil {
		return errors.New("unable to load share token")
	}
	ln, err := h.node.Listen("tcp", ":"+remotePort)
	if err != nil {
		return errors.New("unable to listen on tailnet")
	}
	h.shareToken = secret
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		h.mu.Lock()
		upstream := h.sidecar
		h.mu.Unlock()
		if upstream == nil || address != upstream.Host {
			return nil, errors.New("invalid upstream")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp4", address)
	}}
	proxy := &httputil.ReverseProxy{Transport: transport, FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			h.mu.Lock()
			upstream, user, password := h.sidecar, h.sidecarUser, h.sidecarPass
			h.mu.Unlock()
			if upstream == nil {
				return
			}
			stripHeaders(r.Out.Header)
			r.SetURL(upstream)
			r.Out.SetBasicAuth(user, password)
		},
		ModifyResponse: safeRedirect,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		},
	}
	srv := &http.Server{ErrorLog: log.New(io.Discard, "", 0), Handler: h.tailnetHandler(proxy, secret)}
	h.server = srv
	h.serverConn = trackConnections(ln)
	connections := h.serverConn
	go func() {
		_ = srv.Serve(connections)
		transport.CloseIdleConnections()
	}()
	return nil
}

func (h *helper) tailnetHandler(proxy http.Handler, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !validRequest(r) {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		user, pass, ok := r.BasicAuth()
		if !ok || !secureEqual(user, "remote") || !secureEqual(pass, secret) {
			w.Header().Set("WWW-Authenticate", `Basic realm="remote"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/__haolab/projects" {
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", http.MethodGet)
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			h.mu.Lock()
			directories := append(make([]string, 0, len(h.projects)), h.projects...)
			h.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				Directories []string `json:"directories"`
			}{Directories: directories})
			return
		}
		h.mu.Lock()
		ready := h.sidecar != nil
		h.mu.Unlock()
		if !ready {
			http.Error(w, "sidecar unavailable", http.StatusBadGateway)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func (h *helper) connect(peer *invitation) error {
	secret, err := loadSecret(filepath.Join(h.stateDir, "client.token"))
	if err != nil {
		return errors.New("unable to load client token")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return errors.New("unable to listen on loopback")
	}
	upstream := &url.URL{Scheme: "http", Host: net.JoinHostPort(peer.Host, remotePort)}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != upstream.Host {
			return nil, errors.New("invalid destination")
		}
		return h.node.Dial(ctx, network, address)
	}}
	proxy := &httputil.ReverseProxy{Transport: transport, FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			stripHeaders(r.Out.Header)
			r.SetURL(upstream)
			r.Out.SetBasicAuth("remote", peer.Token)
		},
		ModifyResponse: func(r *http.Response) error {
			for key := range r.Header {
				if strings.HasPrefix(strings.ToLower(key), "access-control-") {
					delete(r.Header, key)
				}
			}
			return safeRedirect(r)
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "remote unavailable", http.StatusBadGateway)
		},
	}
	address := ln.Addr().String()
	srv := &http.Server{ErrorLog: log.New(io.Discard, "", 0), Handler: bridgeHandler(proxy, address, secret, os.Getenv("ELECTRON_RENDERER_URL"))}
	h.localSecret, h.peer, h.bridge, h.bridgeAddr = secret, peer, srv, address
	h.bridgeConn = trackConnections(ln)
	connections := h.bridgeConn
	go func() {
		_ = srv.Serve(connections)
		transport.CloseIdleConnections()
	}()
	return nil
}

func bridgeHandler(proxy http.Handler, address, secret, devURL string) http.Handler {
	var mu sync.Mutex
	tickets := make(map[string]time.Time)
	devOrigin := ""
	if u, err := url.Parse(devURL); err == nil && u != nil && u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") && u.Port() != "" && u.User == nil {
		devOrigin = u.Scheme + "://" + u.Host
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !validRequest(r) || r.Host != address {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		origins := r.Header.Values("Origin")
		if len(origins) > 1 || len(origins) == 1 && (origins[0] == "" || origins[0] != "oc://renderer" && origins[0] != "http://"+address && origins[0] != devOrigin) {
			http.Error(w, "invalid origin", http.StatusForbidden)
			return
		}
		if len(origins) == 1 {
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Origin", origins[0])
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.Header().Add("Vary", "Access-Control-Request-Method")
			w.Header().Add("Vary", "Access-Control-Request-Headers")
			if len(origins) != 1 {
				http.Error(w, "invalid preflight", http.StatusForbidden)
				return
			}
			method := r.Header.Get("Access-Control-Request-Method")
			switch method {
			case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
			default:
				http.Error(w, "invalid preflight", http.StatusForbidden)
				return
			}
			for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
				header = strings.ToLower(strings.TrimSpace(header))
				if header == "" || header == "authorization" || header == "content-type" || header == "accept" || strings.HasPrefix(header, "x-opencode-") {
					continue
				}
				http.Error(w, "invalid preflight", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", method)
			w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/__haolab/ws-ticket" {
			user, pass, ok := r.BasicAuth()
			if !ok || !secureEqual(user, "client") || !secureEqual(pass, secret) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			mu.Lock()
			for key, expires := range tickets {
				if time.Now().After(expires) {
					delete(tickets, key)
				}
			}
			if len(tickets) >= 128 {
				mu.Unlock()
				http.Error(w, "too many pending tickets", http.StatusTooManyRequests)
				return
			}
			bytes := make([]byte, 32)
			if _, err := rand.Read(bytes); err != nil {
				mu.Unlock()
				http.Error(w, "unable to issue ticket", http.StatusInternalServerError)
				return
			}
			ticket := hex.EncodeToString(bytes)
			tickets[ticket] = time.Now().Add(30 * time.Second)
			mu.Unlock()
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				Ticket string `json:"ticket"`
			}{ticket})
			return
		}
		if token := r.URL.Query().Get("bridge_ticket"); token != "" {
			if r.Method != http.MethodGet || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.HasPrefix(r.URL.Path, "/pty/") || !strings.HasSuffix(r.URL.Path, "/connect") || strings.Count(r.URL.Path, "/") != 3 || len(r.URL.Query()["bridge_ticket"]) != 1 {
				http.Error(w, "invalid ticket", http.StatusBadRequest)
				return
			}
			mu.Lock()
			expires, ok := tickets[token]
			delete(tickets, token)
			mu.Unlock()
			if !ok || time.Now().After(expires) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			query := r.URL.Query()
			query.Del("bridge_ticket")
			r.URL.RawQuery = query.Encode()
			proxy.ServeHTTP(w, r)
			return
		}
		user, pass, ok := r.BasicAuth()
		if !ok || !secureEqual(user, "client") || !secureEqual(pass, secret) {
			w.Header().Set("WWW-Authenticate", `Basic realm="client"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

type trackedListener struct {
	net.Listener
	mu     sync.Mutex
	conns  map[net.Conn]struct{}
	closed bool
}

type trackedConn struct {
	net.Conn
	owner *trackedListener
}

func trackConnections(ln net.Listener) *trackedListener {
	return &trackedListener{Listener: ln, conns: make(map[net.Conn]struct{})}
}

func (l *trackedListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tracked := &trackedConn{Conn: conn, owner: l}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		_ = conn.Close()
		return nil, net.ErrClosed
	}
	l.conns[tracked] = struct{}{}
	l.mu.Unlock()
	return tracked, nil
}

func (c *trackedConn) Close() error {
	c.owner.mu.Lock()
	delete(c.owner.conns, c)
	c.owner.mu.Unlock()
	return c.Conn.Close()
}

func (l *trackedListener) closeAll() {
	l.mu.Lock()
	l.closed = true
	conns := make([]net.Conn, 0, len(l.conns))
	for conn := range l.conns {
		conns = append(conns, conn)
	}
	l.mu.Unlock()
	_ = l.Listener.Close()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func (h *helper) close() {
	h.mu.Lock()
	if h.watchCancel != nil {
		h.watchCancel()
		_ = h.watcher.Close()
	}
	if h.bridge != nil {
		_ = h.bridge.Close()
		h.bridgeConn.closeAll()
	}
	if h.server != nil {
		_ = h.server.Close()
		h.serverConn.closeAll()
	}
	if h.node != nil {
		_ = h.node.Close()
	}
	done := h.watchDone
	h.mu.Unlock()
	if done != nil {
		<-done
	}
}

func loadSecret(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			return "", err
		}
		f, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, os.ErrExist) {
			return loadSecret(path)
		}
		if err != nil {
			return "", err
		}
		secret := hex.EncodeToString(bytes)
		_, err = f.WriteString(secret)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			return "", errors.New("unable to save token")
		}
		return secret, nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
		return "", errors.New("invalid token file")
	}
	bytes, err := io.ReadAll(io.LimitReader(f, 65))
	if err != nil || len(bytes) != 64 {
		return "", errors.New("invalid token")
	}
	if decoded, err := hex.DecodeString(string(bytes)); err != nil || len(decoded) != 32 {
		return "", errors.New("invalid token")
	}
	return string(bytes), nil
}

func parseSidecar(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || u.Opaque != "" || u.ForceQuery || strings.HasSuffix(raw, "#") || strings.HasSuffix(u.Host, ":") {
		return nil, errors.New("sidecar must be http://127.0.0.1:<port>")
	}
	port, err := netip.ParseAddrPort(u.Host)
	if err != nil || port.Port() == 0 || u.Host != net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port.Port()))) {
		return nil, errors.New("sidecar must be http://127.0.0.1:<port>")
	}
	return u, nil
}

func parseShare(raw string) (*invitation, error) {
	var share invitation
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&share) != nil || decoder.Decode(new(any)) != io.EOF || (share.Version != 1 && share.Version != 2) || share.Port != 41642 || !validTailnetHost(share.Host) || (share.Version == 2 && !validAuthKey(share.AuthKey)) || (share.Version == 1 && share.AuthKey != "") {
		return nil, errors.New("invalid share")
	}
	decoded, err := hex.DecodeString(share.Token)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid share")
	}
	return &share, nil
}

func validAuthKey(key string) bool {
	return strings.HasPrefix(key, "tskey-auth-") && len(key) > len("tskey-auth-") && len(key) <= 512 && !strings.ContainsAny(key, " \t\r\n")
}

func validTailnetHost(host string) bool {
	if ip, err := netip.ParseAddr(host); err == nil {
		return netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)
	}
	if host != strings.ToLower(host) || !strings.HasSuffix(host, ".ts.net") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return false
			}
		}
	}
	return true
}

func secureEqual(a, b string) bool {
	left, right := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(left[:], right[:]) == 1
}

func validRequest(r *http.Request) bool {
	if r.URL.IsAbs() || r.Method == http.MethodConnect || r.URL.User != nil || r.URL.RawPath != "" && strings.Contains(r.URL.RawPath, "\\") {
		return false
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return false
	}
	for key := range query {
		if strings.EqualFold(key, "auth_token") {
			return false
		}
	}
	return true
}

func stripHeaders(headers http.Header) {
	for key := range headers {
		if strings.HasPrefix(strings.ToLower(key), "proxy-") || strings.EqualFold(key, "forwarded") || strings.HasPrefix(strings.ToLower(key), "x-forwarded-") || strings.EqualFold(key, "x-real-ip") || strings.EqualFold(key, "authorization") {
			delete(headers, key)
		}
	}
}

func safeRedirect(r *http.Response) error {
	location := r.Header.Get("Location")
	if location == "" {
		return nil
	}
	u, err := url.Parse(location)
	if err != nil || u.IsAbs() || u.Host != "" || u.User != nil || strings.HasPrefix(strings.ReplaceAll(location, "\\", "/"), "//") {
		r.Header.Del("Location")
		return nil
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		r.Header.Del("Location")
		return nil
	}
	for key := range query {
		if strings.EqualFold(key, "auth_token") {
			r.Header.Del("Location")
			return nil
		}
	}
	return nil
}
