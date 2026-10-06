import { describe, expect, test } from "bun:test"
import { createMobileHeader } from "./mobile-header"

describe("mobile header registration", () => {
  test("stale route cleanup cannot clear the current session", () => {
    const header = createMobileHeader()
    const previous = Symbol("previous")
    const current = Symbol("current")
    header.register(previous, { id: "one", title: "One", currentTab: "session", onTabChange: () => {} })
    header.register(current, { id: "two", title: "Two", currentTab: "changes", onTabChange: () => {} })
    header.clear(previous)
    expect(header.session()?.id).toBe("two")
    expect(header.session()?.currentTab).toBe("changes")
    header.clear(current)
    expect(header.session()).toBeUndefined()
  })

  test("updates session metadata and delegates changes to its owner", () => {
    const header = createMobileHeader()
    const owner = Symbol("session")
    const tabs: string[] = []
    header.register(owner, { id: "one", title: "", currentTab: "session", onTabChange: (tab) => tabs.push(tab) })
    header.session()?.onTabChange("changes")
    header.register(owner, { id: "one", title: "Loaded title", currentTab: "changes", onTabChange: (tab) => tabs.push(tab) })
    expect(header.session()?.title).toBe("Loaded title")
    expect(header.session()?.currentTab).toBe("changes")
    expect(tabs).toEqual(["changes"])
    expect(createMobileHeader().session()).toBeUndefined()
  })
})
