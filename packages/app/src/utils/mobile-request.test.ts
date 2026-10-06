import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { retry } from "@opencode-ai/core/util/retry"
import { QueryClient } from "@tanstack/solid-query"
import { loadGlobalConfigQuery } from "../context/global-sync/bootstrap"
import { createMobileReadTransport, linkAbortSignals } from "./mobile-request"

describe("mobile SDK read transport", () => {
  test("works without AbortSignal.any or throwIfAborted", async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")
    const throwIfAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "throwIfAborted")
    try {
      Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
      Object.defineProperty(AbortSignal.prototype, "throwIfAborted", { configurable: true, value: undefined })
      let hold = true
      const transport = createMobileReadTransport(Object.assign(async () => {
        if (hold) return new Promise<Response>(() => {})
        return Response.json({ username: "fresh" })
      }, { preconnect: fetch.preconnect }), undefined, 20)
      const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
      const old = sdk.global.config.get().catch((error: unknown) => error)
      await Bun.sleep(0)
      transport.invalidate()
      expect(await old).toMatchObject({ name: "AbortError" })
      await expect(sdk.global.config.get()).rejects.toMatchObject({ name: "TimeoutError" })
      hold = false
      expect((await sdk.global.config.get()).data?.username).toBe("fresh")
    } finally {
      if (any) Object.defineProperty(AbortSignal, "any", any)
      if (!any) Reflect.deleteProperty(AbortSignal, "any")
      if (throwIfAborted) Object.defineProperty(AbortSignal.prototype, "throwIfAborted", throwIfAborted)
      if (!throwIfAborted) Reflect.deleteProperty(AbortSignal.prototype, "throwIfAborted")
    }
  })

  test("linked caller and epoch signals retain the first reason and detach after completion", () => {
    const caller = new AbortController()
    const epoch = new AbortController()
    const controller = new AbortController()
    const unlink = linkAbortSignals(controller, [caller.signal, epoch.signal])
    const reason = new DOMException("Caller cancelled", "AbortError")
    caller.abort(reason)
    expect(controller.signal.reason).toBe(reason)
    epoch.abort()
    expect(controller.signal.reason).toBe(reason)
    unlink()
    const completed = new AbortController()
    const later = new AbortController()
    linkAbortSignals(completed, [later.signal])()
    later.abort()
    expect(completed.signal.aborted).toBe(false)
    const already = new AbortController()
    linkAbortSignals(already, [caller.signal])()
    expect(already.signal.reason).toBe(reason)
  })

  test("bounds stalled headers without retrying a timeout", async () => {
    let calls = 0
    const transport = createMobileReadTransport(Object.assign(() => {
      calls++
      return new Promise<Response>(() => {})
    }, { preconnect: fetch.preconnect }), undefined, 20)
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    await expect(retry(() => sdk.global.config.get())).rejects.toMatchObject({ name: "TimeoutError" })
    expect(calls).toBe(1)
  })

  test("keeps the deadline through a partial response body", async () => {
    const transport = createMobileReadTransport(Object.assign(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"agent":')) },
    }), { headers: { "content-type": "application/json" } }), { preconnect: fetch.preconnect }), undefined, 20)
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    await expect(sdk.global.config.get()).rejects.toMatchObject({ name: "TimeoutError" })
  })

  test("epoch cancellation settles ignored aborts and a late response cannot replace the new read", async () => {
    let release: ((value: Response) => void) | undefined
    const requests: Request[] = []
    const transport = createMobileReadTransport(Object.assign(async (input: RequestInfo | URL) => {
      requests.push(new Request(input))
      if (requests.length === 1) return new Promise<Response>((resolve) => { release = resolve })
      return Response.json({ username: "fresh" })
    }, { preconnect: fetch.preconnect }))
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    const old = retry(() => sdk.global.config.get()).catch((error: unknown) => error)
    await Bun.sleep(0)
    transport.invalidate()
    expect(await old).toMatchObject({ name: "AbortError" })
    expect(requests[0].signal.aborted).toBe(true)
    expect((await sdk.global.config.get()).data?.username).toBe("fresh")
    release?.(Response.json({ username: "stale" }))
    await Bun.sleep(0)
    expect(requests).toHaveLength(2)
  })

  test("combines caller cancellation with epoch cancellation", async () => {
    const transport = createMobileReadTransport(Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }))
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    const caller = new AbortController()
    const read = sdk.global.config.get({ signal: caller.signal }).catch((error: unknown) => error)
    await Bun.sleep(0)
    caller.abort()
    expect(await read).toMatchObject({ name: "AbortError" })
  })

  test("does not cancel or replay mutations on epoch changes", async () => {
    let release: ((value: Response) => void) | undefined
    const requests: Request[] = []
    const transport = createMobileReadTransport(Object.assign(async (input: RequestInfo | URL) => {
      requests.push(new Request(input))
      return new Promise<Response>((resolve) => { release = resolve })
    }, { preconnect: fetch.preconnect }), undefined, 10)
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    const mutation = sdk.session.promptAsync({ sessionID: "ses_fixture", parts: [{ type: "text", text: "synthetic" }] })
    await Bun.sleep(20)
    transport.invalidate()
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe("POST")
    expect(requests[0].signal.aborted).toBe(false)
    release?.(new Response(null, { status: 204 }))
    await mutation
    expect(requests).toHaveLength(1)
  })

  for (const body of [false, true]) test(`bounds the read-only reconciliation POST through ${body ? "body" : "headers"}`, async () => {
    const requests: Request[] = []
    const transport = createMobileReadTransport(Object.assign(async (input: RequestInfo | URL) => {
      requests.push(new Request(input))
      if (!body) return new Promise<Response>(() => {})
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"upserts":'))
      } }), { headers: { "content-type": "application/json" } })
    }, { preconnect: fetch.preconnect }), undefined, 20)
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    await expect(sdk.session.reconcile({ directory: "/synthetic", known: [], limit: 10 })).rejects.toMatchObject({ name: "TimeoutError" })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe("POST")
    expect(new URL(requests[0].url).pathname).toBe("/session/sidebar/reconcile")
    expect(requests[0].signal.aborted).toBe(true)
  })

  test("epoch and caller cancellation replace read-only reconciliation without replaying it", async () => {
    const requests: Request[] = []
    const transport = createMobileReadTransport(Object.assign(async (input: RequestInfo | URL) => {
      requests.push(new Request(input))
      if (requests.length < 3) return new Promise<Response>(() => {})
      return Response.json({ upserts: [], removed: [], limit: 10, limited: false })
    }, { preconnect: fetch.preconnect }))
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    const old = sdk.session.reconcile({ directory: "/synthetic", known: [], limit: 10 }).catch((error: unknown) => error)
    await Bun.sleep(0)
    transport.invalidate()
    expect(await old).toMatchObject({ name: "AbortError" })
    expect(requests[0].signal.aborted).toBe(true)
    const caller = new AbortController()
    const cancelled = sdk.session.reconcile({ directory: "/synthetic", known: [], limit: 10 }, { signal: caller.signal }).catch((error: unknown) => error)
    await Bun.sleep(0)
    caller.abort()
    expect(await cancelled).toMatchObject({ name: "AbortError" })
    expect(requests[1].signal.aborted).toBe(true)
    expect((await sdk.session.reconcile({ directory: "/synthetic", known: [], limit: 10 })).data?.removed).toEqual([])
    expect(requests).toHaveLength(3)
  })

  test("TanStack cancels actual query SDK reads without discarding previously cached data", async () => {
    let release: ((value: Response) => void) | undefined
    const requests: Request[] = []
    const transport = createMobileReadTransport(Object.assign(async (input: RequestInfo | URL) => {
      requests.push(new Request(input))
      if (requests.length === 1) return new Promise<Response>((resolve) => { release = resolve })
      return Response.json({ username: "fresh" })
    }, { preconnect: fetch.preconnect }))
    const sdk = createOpencodeClient({ baseUrl: "http://fixture.test", fetch: transport.fetch, throwOnError: true })
    const queries = new QueryClient()
    queries.setQueryData(["config"], { username: "cached" })
    const old = queries.fetchQuery(loadGlobalConfigQuery(sdk, true)).catch(() => undefined)
    await Bun.sleep(0)
    await queries.cancelQueries({ queryKey: ["config"] })
    expect(requests[0].signal.aborted).toBe(true)
    expect(queries.getQueryData<{ username: string }>(["config"])).toEqual({ username: "cached" })
    await queries.fetchQuery(loadGlobalConfigQuery(sdk, true))
    release?.(Response.json({ username: "stale" }))
    await old
    await Bun.sleep(0)
    expect(queries.getQueryData<{ username: string }>(["config"])).toEqual({ username: "fresh" })
    queries.clear()
  })
})
