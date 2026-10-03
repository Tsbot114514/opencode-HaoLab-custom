import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"

test("sidebar migrations keep existing sessions without backfilling disposable changes", async () => {
  const db = new Database(":memory:")
  try {
    db.exec(`CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL,
      parent_id text, time_archived integer, title text NOT NULL, slug text NOT NULL,
      version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL
    )`)
    const insert = db.prepare(
      "INSERT INTO session (id, project_id, directory, title, slug, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    db.transaction(() => {
      Array.from({ length: 50 }, (_, index) => index).forEach((index) =>
        insert.run(`ses_${index}`, "project", "/work", `title-${index}`, `slug-${index}`, "1", index, index),
      )
    })()

    for (const name of [
      "20260930013616_session_sidebar_change",
      "20260930015239_session_sidebar_retention",
      "20260930021505_session_sidebar_order",
      "20260930024422_session_sidebar_count",
    ]) {
      const sql = await Bun.file(path.join(import.meta.dir, "../../migration", name, "migration.sql")).text()
      sql.split("--> statement-breakpoint").filter((statement) => statement.trim()).forEach((statement) => db.exec(statement))
    }

    expect(db.query("SELECT count(*) AS total FROM session").get()).toEqual({ total: 50 })
    expect(db.query("SELECT count(*) AS total FROM session_sidebar_base").get()).toEqual({ total: 50 })
    expect(db.query("SELECT count(*) AS total FROM session_sidebar_change").get()).toEqual({ total: 0 })
    expect(db.query("SELECT seq, floor FROM session_sidebar_state").get()).toEqual({ seq: 0, floor: 0 })
    expect(db.query("SELECT total FROM session_sidebar_count").get()).toEqual({ total: 50 })

    db.query("UPDATE session SET title = 'changed' WHERE id = 'ses_0'").run()
    expect(db.query("SELECT seq, title FROM session_sidebar_change").get()).toEqual({ seq: 1, title: "changed" })
    expect(db.query("SELECT seq FROM session_sidebar_state").get()).toEqual({ seq: 1 })
  } finally {
    db.close()
  }
})
