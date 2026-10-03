import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"

export function init(path: string, readonly = false) {
  const sqlite = new DatabaseSync(path, { readOnly: readonly, allowExtension: false })
  const db = drizzle({ client: sqlite })
  return db
}
