import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

describe("transcript feed migration", () => {
  test("backfills generations without copying existing history and installs mutation triggers", () => {
    const sqlite = new Database(":memory:")
    sqlite.run("PRAGMA foreign_keys=ON")
    const db = drizzle({ client: sqlite })
    const directory = path.join(import.meta.dirname, "../../migration")
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        timestamp: Number(entry.name.split("_")[0]),
        sql: readFileSync(path.join(directory, entry.name, "migration.sql"), "utf8"),
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
    const index = entries.findIndex((entry) => entry.name.endsWith("_session_transcript_feed"))
    expect(index).toBeGreaterThan(0)
    migrate(db, entries.slice(0, index))
    sqlite.run(
      "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project','/project',1,1,'[]')",
    )
    sqlite.run(
      "INSERT INTO session (id,project_id,directory,slug,title,version,time_created,time_updated) VALUES ('session','project','/project','slug','title','1',1,1)",
    )
    sqlite.run(
      "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('message','session',1,1,'{}')",
    )
    sqlite.run(
      "INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('part','message','session',1,1,'{}')",
    )
    migrate(db, entries.slice(index))
    expect(sqlite.query("SELECT count(*) AS total FROM session_transcript_change").get()).toEqual({ total: 0 })
    const before = sqlite.query<{ generation: string }, []>("SELECT generation FROM session_transcript_state").get()
    expect(before?.generation).toHaveLength(32)
    sqlite.run('UPDATE part SET data=\'{"type":"text","text":"changed"}\' WHERE id=\'part\'')
    expect(sqlite.query("SELECT kind,message_id,part_id FROM session_transcript_change").get()).toEqual({
      kind: "part",
      message_id: "message",
      part_id: "part",
    })
    sqlite.run("DELETE FROM session WHERE id='session'")
    expect(sqlite.query("SELECT deleted FROM session_transcript_state").get()).toEqual({ deleted: 1 })
    sqlite.run(
      "INSERT INTO session (id,project_id,directory,slug,title,version,time_created,time_updated) VALUES ('session','project','/project','slug','title','1',1,1)",
    )
    expect(
      sqlite.query<{ generation: string }, []>("SELECT generation FROM session_transcript_state").get()?.generation,
    ).not.toBe(before?.generation)
    expect(sqlite.query("SELECT seq,floor FROM session_transcript_meta").get()).toEqual({ seq: 5, floor: 0 })
    sqlite.close()
  })
})
