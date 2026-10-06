package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn"
)

func TestRetryPendingLogin(t *testing.T) {
	now := time.Now()
	for _, state := range []string{"NeedsLogin", "NoState"} {
		if !shouldRetryLogin(state, time.Time{}, now) || !shouldRetryLogin(state, now.Add(-5*time.Second), now) {
			t.Errorf("did not retry pending %s login", state)
		}
		if shouldRetryLogin(state, now.Add(-4*time.Second), now) {
			t.Errorf("retried %s login before cooldown", state)
		}
	}
	if shouldRetryLogin("Running", time.Time{}, now) || shouldRetryLogin("Stopped", time.Time{}, now) {
		t.Fatal("retried login outside pending state")
	}
}

func TestSidecarURL(t *testing.T) {
	if _, err := parseSidecar("http://127.0.0.1:4567"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"http://localhost:4567", "http://127.0.0.1:0", "http://127.0.0.1:4567/", "http://127.0.0.1:4567?x=1", "http://user:pass@127.0.0.1:4567", "http://127.0.0.1:99999", "https://127.0.0.1:4567"} {
		if _, err := parseSidecar(raw); err == nil {
			t.Errorf("accepted invalid sidecar URL: %q", raw)
		}
	}
}

func TestShareValidation(t *testing.T) {
	token := strings.Repeat("ab", 32)
	authKey := "tskey-auth-" + strings.Repeat("a", 32)
	for _, host := range []string{"haolab-code.example.ts.net", "100.101.102.103", "fd7a:115c:a1e0::1"} {
		share, _ := json.Marshal(invitation{Version: 2, Host: host, Port: 41642, Token: token, AuthKey: authKey})
		peer, err := parseShare(string(share))
		if err != nil || peer.AuthKey != authKey {
			t.Errorf("did not preserve auth key for %q", host)
		}
	}
	legacy, _ := json.Marshal(invitation{Version: 1, Host: "haolab-code.example.ts.net", Port: 41642, Token: token})
	if _, err := parseShare(string(legacy)); err != nil {
		t.Fatal("rejected previously saved pairing")
	}
	for _, key := range []string{"", "tskey-client-not-an-auth-key", "tskey-auth-\nsecret", "tskey-auth-" + strings.Repeat("a", 513)} {
		share, _ := json.Marshal(invitation{Version: 2, Host: "haolab-code.example.ts.net", Port: 41642, Token: token, AuthKey: key})
		if _, err := parseShare(string(share)); err == nil {
			t.Fatal("accepted invalid tailnet auth key")
		}
	}
	for _, host := range []string{"localhost", "example.com", "evil.ts.net.attacker.com", "127.0.0.1", "100.128.0.1", "fd00::1", "-x.ts.net", "a..ts.net"} {
		share, _ := json.Marshal(invitation{Version: 2, Host: host, Port: 41642, Token: token, AuthKey: authKey})
		if _, err := parseShare(string(share)); err != nil {
			continue
		}
		t.Errorf("accepted untrusted host %q", host)
	}
	if _, err := parseShare(`{"version":1,"host":"x.ts.net","port":41642,"token":"abc","extra":1}`); err == nil {
		t.Fatal("accepted unknown field")
	}
}

func TestAuthKeyCommandDoesNotExposeKey(t *testing.T) {
	h := &helper{}
	key := "tskey-auth-" + strings.Repeat("a", 32)
	status, err := h.execute(command{Command: "auth-key", AuthKey: key})
	if err != nil || !status.HasAuthKey || status.Share != "" || h.authKey != key {
		t.Fatal("failed to configure auth key without sharing it in status")
	}
	for _, invalid := range []string{"", "tskey-client-invalid", "tskey-auth-invalid key"} {
		if _, err := h.execute(command{Command: "auth-key", AuthKey: invalid}); err == nil || invalid != "" && strings.Contains(err.Error(), invalid) {
			t.Fatal("invalid auth key accepted or leaked")
		}
	}
}

func TestProjectsCommand(t *testing.T) {
	h := &helper{}
	first := filepath.Join(t.TempDir(), "repo")
	second := filepath.Join(t.TempDir(), "not-a-git-repo")
	var cmd command
	if err := json.Unmarshal([]byte(`{"command":"projects","projects":[`+strconv.Quote(first)+`,`+strconv.Quote(second)+`]}`), &cmd); err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(cmd); err != nil {
		t.Fatal(err)
	}
	cmd.Projects[0] = second
	if h.projects[0] != first || h.projects[1] != second {
		t.Fatal("snapshot did not preserve ordered, independent paths")
	}
	for _, projects := range [][]string{
		{""}, {"relative/path"}, {first, first}, {first, filepath.Join(first, ".") + string(filepath.Separator)},
		make([]string, 513),
	} {
		if _, err := h.execute(command{Command: "projects", Projects: projects}); err == nil || strings.Contains(err.Error(), first) {
			t.Fatal("invalid projects accepted or path leaked")
		}
		if h.projects[0] != first || h.projects[1] != second {
			t.Fatal("invalid command replaced snapshot")
		}
	}
	if _, err := h.execute(command{Command: "projects"}); err != nil || len(h.projects) != 0 {
		t.Fatal("empty snapshot did not clear projects")
	}
}

func TestTailnetProjectsRoute(t *testing.T) {
	h := &helper{}
	path := filepath.Join(t.TempDir(), "plain-directory")
	if _, err := h.execute(command{Command: "projects", Projects: []string{path}}); err != nil {
		t.Fatal(err)
	}
	handler := h.tailnetHandler(http.NotFoundHandler(), "secret")
	for _, tc := range []struct {
		method string
		url    string
		auth   bool
		status int
	}{
		{http.MethodGet, "/__haolab/projects", false, http.StatusUnauthorized},
		{http.MethodPost, "/__haolab/projects", false, http.StatusUnauthorized},
		{http.MethodGet, "/__haolab/projects?auth_token=secret", true, http.StatusBadRequest},
		{http.MethodPost, "/__haolab/projects", true, http.StatusMethodNotAllowed},
		{http.MethodPut, "/__haolab/projects", true, http.StatusMethodNotAllowed},
		{http.MethodDelete, "/__haolab/projects", true, http.StatusMethodNotAllowed},
		{http.MethodGet, "/__haolab/projects", true, http.StatusOK},
	} {
		req := httptest.NewRequest(tc.method, tc.url, nil)
		if tc.auth {
			req.SetBasicAuth("remote", "secret")
		}
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, req)
		if resp.Code != tc.status {
			t.Fatalf("%s %s authenticated=%v: %d", tc.method, tc.url, tc.auth, resp.Code)
		}
		if tc.status != http.StatusOK {
			continue
		}
		var body struct {
			Directories []string `json:"directories"`
		}
		if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil || len(body.Directories) != 1 || body.Directories[0] != path || resp.Header().Get("Content-Type") != "application/json" {
			t.Fatal("invalid projects response")
		}
	}
	if _, err := h.execute(command{Command: "projects"}); err != nil {
		t.Fatal(err)
	}
	resp := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/__haolab/projects", nil)
	req.SetBasicAuth("remote", "secret")
	handler.ServeHTTP(resp, req)
	if strings.TrimSpace(resp.Body.String()) != `{"directories":[]}` {
		t.Fatal("empty snapshot was not encoded as an array")
	}
}

func TestAuthAndRequestFiltering(t *testing.T) {
	if !secureEqual("remote", "remote") || secureEqual("remote", "client") || secureEqual("secret", "different") {
		t.Fatal("invalid authentication comparison")
	}
	for _, path := range []string{"/x?auth_token=secret", "/x?AUTH_TOKEN=secret"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if validRequest(req) {
			t.Errorf("accepted credential query: %s", path)
		}
	}
	header := http.Header{"Authorization": {"Basic secret"}, "Proxy-Authorization": {"secret"}, "Forwarded": {"for=remote"}, "X-Forwarded-For": {"remote"}, "X-Real-Ip": {"remote"}, "Accept": {"text/event-stream"}}
	stripHeaders(header)
	if len(header) != 1 || header.Get("Accept") != "text/event-stream" {
		t.Fatalf("unsafe forwarded headers: %v", header)
	}
	for _, location := range []string{"https://attacker.example/", "//attacker.example/", "///attacker.example/", "/\\attacker.example/", "/?auth_token=secret"} {
		resp := &http.Response{Header: http.Header{"Location": {location}}}
		_ = safeRedirect(resp)
		if resp.Header.Get("Location") != "" {
			t.Errorf("unsafe redirect: %s", location)
		}
	}
}

func TestSecretPermissionsAndNoSidecarPersistence(t *testing.T) {
	dir := t.TempDir()
	first, err := loadSecret(filepath.Join(dir, "share.token"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadSecret(filepath.Join(dir, "share.token"))
	if err != nil || first != second || len(first) != 64 {
		t.Fatal("token did not persist")
	}
	st, err := os.Stat(filepath.Join(dir, "share.token"))
	if err != nil || runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
		t.Fatal("token has unsafe permissions")
	}
	h := &helper{stateDir: dir}
	_, err = h.execute(command{Command: "sidecar", URL: "http://127.0.0.1:12345", Username: "private-user", Password: "private-password"})
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatal("sidecar command persisted credentials")
	}
	_, err = h.execute(command{Command: "sidecar", URL: "http://private-password@example.com"})
	if err == nil || strings.Contains(err.Error(), "private-password") {
		t.Fatal("error leaked credential")
	}
}

func TestBridgeCORSAndAuthentication(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := ln.Addr().String()
	srv := &http.Server{Handler: bridgeHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ok\n\n")
	}), address, "secret", "http://localhost:5173/app")}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	for _, origin := range []string{"oc://renderer", "http://localhost:5173", "http://" + address} {
		req, _ := http.NewRequest(http.MethodOptions, "http://"+address+"/event", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "GET")
		req.Header.Set("Access-Control-Request-Headers", "authorization, x-opencode-directory")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != origin || resp.Header.Get("Access-Control-Allow-Credentials") != "true" || resp.Header.Get("Access-Control-Allow-Headers") != "authorization, x-opencode-directory" {
			t.Errorf("preflight %q: %d, %v", origin, resp.StatusCode, resp.Header)
		}
	}
	for _, origin := range []string{"http://evil.example", "http://localhost:6000", "null"} {
		req, _ := http.NewRequest(http.MethodOptions, "http://"+address+"/", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden || resp.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("allowed untrusted origin %q: %d", origin, resp.StatusCode)
		}
	}
	req, _ := http.NewRequest(http.MethodOptions, "http://"+address+"/", nil)
	req.Header.Set("Origin", "oc://renderer")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "proxy-authorization")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("allowed unsafe preflight: %d", resp.StatusCode)
	}
	for _, authorized := range []bool{false, true} {
		req, _ := http.NewRequest(http.MethodGet, "http://"+address+"/event", nil)
		req.Header.Set("Origin", "oc://renderer")
		if authorized {
			req.SetBasicAuth("client", "secret")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if !authorized && resp.StatusCode != http.StatusUnauthorized || authorized && (resp.StatusCode != http.StatusOK || string(body) != "data: ok\n\n" || resp.Header.Get("Access-Control-Allow-Origin") != "oc://renderer") {
			t.Errorf("request authenticated=%v: %d %q", authorized, resp.StatusCode, body)
		}
	}
}

func TestBridgeWebSocketTicket(t *testing.T) {
	address := "127.0.0.1:41643"
	called := 0
	handler := bridgeHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		if r.URL.RawQuery != "ticket=sidecar" {
			t.Errorf("forwarded bridge credential: %q", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusSwitchingProtocols)
	}), address, "secret", "")
	request := httptest.NewRequest(http.MethodPost, "/__haolab/ws-ticket", nil)
	request.Host = address
	request.SetBasicAuth("client", "secret")
	issued := httptest.NewRecorder()
	handler.ServeHTTP(issued, request)
	if issued.Code != http.StatusOK || issued.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("failed to issue bridge ticket: %d %s", issued.Code, issued.Body.String())
	}
	var result struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(issued.Body.Bytes(), &result); err != nil || len(result.Ticket) != 64 {
		t.Fatal("invalid bridge ticket")
	}
	for index, path := range []string{
		"/session?bridge_ticket=" + result.Ticket,
		"/pty/pty-1/connect?ticket=sidecar&bridge_ticket=" + result.Ticket,
		"/pty/pty-1/connect?ticket=sidecar&bridge_ticket=" + result.Ticket,
	} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Host = address
		r.Header.Set("Origin", "oc://renderer")
		r.Header.Set("Upgrade", "websocket")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		expected := []int{http.StatusBadRequest, http.StatusSwitchingProtocols, http.StatusUnauthorized}[index]
		if w.Code != expected {
			t.Errorf("unexpected ticket response: %d, want %d", w.Code, expected)
		}
	}
	if called != 1 {
		t.Fatalf("expected one authenticated upgrade, got %d", called)
	}
	unauthorized := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/__haolab/ws-ticket", nil)
	request.Host = address
	handler.ServeHTTP(unauthorized, request)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatal("issued ticket without local credentials")
	}
}

func TestTrackedListenerClosesHijackedConnections(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tracked := trackConnections(ln)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\n\r\n"))
	})}
	go func() { _ = srv.Serve(tracked) }()
	conn, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = conn.Write([]byte("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"))
	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	_ = srv.Close()
	tracked.closeAll()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("hijacked connection survived shutdown")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("hijacked connection was not closed")
	}
}

func TestBridgeDynamicAddress(t *testing.T) {
	h := &helper{stateDir: t.TempDir()}
	peer := &invitation{Version: 1, Host: "test.ts.net", Port: 41642, Token: strings.Repeat("ab", 32)}
	if err := h.connect(peer); err != nil {
		t.Fatal(err)
	}
	defer h.close()
	status := h.status()
	if status.Connection == nil || status.Connection.URL != "http://"+h.bridgeAddr || status.Connection.URL == "http://127.0.0.1:0" || status.Connection.Host != peer.Host {
		t.Fatalf("invalid connection: %+v", status.Connection)
	}
	if status.AutoJoin {
		t.Fatal("legacy pairing unexpectedly attempted automatic login")
	}
	h.peer.AuthKey = "tskey-auth-" + strings.Repeat("a", 32)
	if !h.status().AutoJoin {
		t.Fatal("new pairing did not report automatic login")
	}
	req, _ := http.NewRequest(http.MethodGet, status.Connection.URL+"/", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated bridge: %d", resp.StatusCode)
	}
}

func TestLoginNotificationCache(t *testing.T) {
	h := &helper{authReady: make(chan struct{})}
	login := "https://login.tailscale.com/a/test"
	needsLogin := ipn.NeedsLogin
	h.recordLogin(ipn.Notify{State: &needsLogin, BrowseToURL: &login})
	if h.authURL != login {
		t.Fatal("login URL was not cached")
	}
	select {
	case <-h.authReady:
	default:
		t.Fatal("login waiter was not notified")
	}
	h.recordLogin(ipn.Notify{BrowseToURL: &login}) // A repeated URL must not close the channel twice.
	running := ipn.Running
	h.recordLogin(ipn.Notify{State: &running})
	if h.authURL != "" {
		t.Fatal("online state retained stale login URL")
	}
}
