import { createStore } from "solid-js/store"

export type MobileHeaderRegistration = {
  id: string
  title: string
  currentTab: "session" | "changes"
  onTabChange: (tab: "session" | "changes") => void
}

export function createMobileHeader() {
  const [store, setStore] = createStore({
    owner: undefined as symbol | undefined,
    session: undefined as MobileHeaderRegistration | undefined,
  })
  return {
    session: () => store.session,
    register(owner: symbol, session: MobileHeaderRegistration) {
      setStore({ owner, session })
    },
    clear(owner: symbol) {
      // An old route disposing must not clear its replacement's header.
      if (store.owner !== owner) return
      setStore({ owner: undefined, session: undefined })
    },
  }
}
