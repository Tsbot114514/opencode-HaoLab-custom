import { describe, expect, test } from "bun:test"
import { resolveServerList, ServerConnection } from "./server"

describe("resolveServerList", () => {
  test("lets startup auth_token credentials override a persisted same-url server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "opencode",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "secret",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : false).toBe(true)
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("keeps persisted credentials when startup has no auth_token", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "opencode",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "saved",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : true).toBeUndefined()
  })

  test("replaces a persisted tunnel bridge with the fresh connection for its host", () => {
    const stored: ServerConnection.Tunnel = {
      type: "tunnel",
      host: "host.example.test",
      http: { url: "http://127.0.0.1:41643", username: "old", password: "old" },
    }
    const live: ServerConnection.Tunnel = {
      type: "tunnel",
      host: stored.host,
      http: { url: "http://127.0.0.1:49152", username: "new", password: "new" },
    }
    const list = resolveServerList({ stored: [stored], props: [live] })

    expect(list).toEqual([live])
    expect(ServerConnection.key(list[0]!)).toBe(ServerConnection.Key.make("tunnel:host.example.test"))
  })

  test("does not offer a persisted tunnel when desktop has no live connection", () => {
    const list = resolveServerList({
      stored: [{ type: "tunnel", host: "host.example.test", http: { url: "http://127.0.0.1:41643" } }],
      props: [{ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } }],
    })

    expect(list).toHaveLength(1)
    expect(ServerConnection.key(list[0]!)).toBe(ServerConnection.Key.make("sidecar"))
  })
})
