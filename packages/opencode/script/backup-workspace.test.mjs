import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const script = fileURLToPath(new URL("./backup-workspace.mjs", import.meta.url))
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (data) => {
      stdout += data
    })
    child.stderr.on("data", (data) => {
      stderr += data
    })
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

test("help and missing arguments never access source data", async () => {
  assert.equal((await run(["--help"])).code, 0)
  const missing = await run([])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /--directory and --output are required/)
})

test("synthetic snapshot, large raw cells, scoped status and safe preflight", { timeout: 180000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-workspace-test-"))
  const workspace = path.join(root, "workspace")
  const data = path.join(root, "data")
  const output = path.join(root, "output")
  await Promise.all([workspace, data, output].map((folder) => fs.mkdir(folder)))
  await fs.mkdir(path.join(workspace, "child"))
  await fs.writeFile(path.join(workspace, "note.txt"), "synthetic only")
  await fs.mkdir(path.join(workspace, "node_modules"))
  await fs.writeFile(path.join(workspace, "node_modules", "excluded.txt"), "not exported")
  const dbfile = path.join(data, "opencode.db")
  const db = new DatabaseSync(dbfile)
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY);
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, project_id TEXT REFERENCES project(id), time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), message_id TEXT REFERENCES message(id), data TEXT, binary BLOB, number INTEGER, fraction REAL);
    CREATE TABLE todo (session_id TEXT REFERENCES session(id), position INTEGER, data TEXT, PRIMARY KEY(session_id,position));
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id), data TEXT);
    INSERT INTO project VALUES ('project_fixture');
  `)
  const sessions = [
    { id: "ses_fixture", directory: workspace, time: { updated: 42 } },
    { id: "ses_child", directory: path.join(workspace, "child"), time: { updated: 43 } },
    { id: "ses_other", directory: path.join(root, "other"), time: { updated: 44 } },
  ]
  for (const session of sessions)
    db.prepare("INSERT INTO session VALUES (?,?,?,?)").run(
      session.id,
      session.directory,
      "project_fixture",
      session.time.updated,
    )
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("msg_fixture", "ses_fixture", '{ "preserve" : true }')
  // Exceeds the former 64 MiB JSON-row boundary, with native integer/blob/null fidelity.
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(
    "part_fixture",
    "ses_fixture",
    "msg_fixture",
    '{ "raw" : "' + "x".repeat(65 * 1024 ** 2) + '" }',
    Buffer.from([0, 255, 1]),
    9223372036854775807n,
    0.125,
  )
  db.prepare("INSERT INTO todo VALUES (?,?,?)").run("ses_child", 0, null)
  db.close()
  let active = "ses_other"
  let mismatch = false
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json")
    if (request.headers.authorization !== `Basic ${Buffer.from("fixture:fixture").toString("base64")}`) {
      response.writeHead(401)
      response.end("{}")
      return
    }
    const route = new URL(request.url, "http://localhost").pathname
    if (route === "/path") {
      response.end(JSON.stringify({ data }))
      return
    }
    if (route === "/session") {
      response.end(JSON.stringify([{ ...sessions[0], time: { updated: mismatch ? 99 : 42 } }]))
      return
    }
    if (route === "/session/status") {
      response.end(JSON.stringify({ [active]: { type: "busy" } }))
      return
    }
    response.writeHead(404)
    response.end("{}")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const connection = path.join(root, "connection.json")
  await fs.writeFile(
    connection,
    JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, username: "fixture", password: "fixture" }),
  )
  const args = ["--directory", workspace, "--output", output, "--connection", connection]
  try {
    active = "ses_child"
    const busy = await run(args)
    assert.equal(busy.code, 1, busy.stderr)
    assert.match(busy.stderr, /active sessions/)
    assert.deepEqual(await fs.readdir(output), [])
    active = "ses_other"
    mismatch = true
    assert.match((await run(args)).stderr, /do not match database/)
    mismatch = false
    assert.match((await run([...args, "--name", "../unsafe"])).stderr, /safe filename/)
    assert.match(
      (await run(["--directory", workspace, "--output", workspace, "--connection", connection])).stderr,
      /outside source/,
    )
    assert.match((await run([...args, "--database", path.join(data, "missing.db")])).stderr, /ENOENT/)
    assert.match((await run([...args, "--max-bytes", "1024"])).stderr, /cap/)
    assert.deepEqual(await fs.readdir(output), [])
    const result = await run(args)
    assert.equal(result.code, 0, result.stderr)
    const success = JSON.parse(result.stdout.trim().split("\n").at(-1))
    const report = JSON.parse(await fs.readFile(success.report, "utf8"))
    assert.equal(report.counts.sessions, 2)
    assert.equal(report.counts.parts, 1)
    assert.ok(report.database.checksums.part.maxCellBytes > 64 * 1024 ** 2)
    assert.ok(Object.values(report.verification).every(Boolean))
    assert.deepEqual(report.missingSessionFolders, ["ses_child", "ses_fixture"])
    assert.deepEqual(report.excludedPaths, ["workspace/node_modules"])
    await assert.rejects(fs.stat(path.join(workspace, ".opencode-project.json")), { code: "ENOENT" })
    await assert.rejects(fs.stat(success.archive + ".partial"), { code: "ENOENT" })
    const extracted = new DatabaseSync(path.join(report.output, "verified-extracted-sessions.sqlite"), {
      readOnly: true,
    })
    try {
      const stmt = extracted.prepare("SELECT binary, number, fraction, substr(data,1,11) prefix FROM part")
      stmt.setReadBigInts(true)
      const row = stmt.get()
      assert.equal(row.number, 9223372036854775807n)
      assert.equal(row.fraction, 0.125)
      assert.deepEqual(Buffer.from(row.binary), Buffer.from([0, 255, 1]))
      assert.equal(row.prefix, '{ "raw" : "')
      assert.equal(extracted.prepare("SELECT data FROM todo").get().data, null)
    } finally {
      extracted.close()
    }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
})
