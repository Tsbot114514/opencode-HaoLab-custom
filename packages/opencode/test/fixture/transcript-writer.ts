import { Database } from "bun:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Schema } from "effect"

const input = Schema.decodeUnknownSync(
  Schema.Struct({
    path: Schema.String,
    messageID: Schema.String,
    partID: Schema.String,
    signal: Schema.instanceOf(SharedArrayBuffer),
  }),
)(workerData)
const signal = new Int32Array(input.signal)
const db = new Database(input.path)
db.run("PRAGMA busy_timeout=5000")
db.run("PRAGMA foreign_keys=ON")
const message = db.query("UPDATE message SET data=json_set(data,'$.agent',?) WHERE id=?")
const part = db.query("UPDATE part SET data=json_set(data,'$.text',?) WHERE id=?")
const update = db.transaction((value: string) => {
  message.run(value, input.messageID)
  part.run(value, input.partID)
})
parentPort?.postMessage("ready")
Atomics.wait(signal, 0, 0)
for (let index = 0; index < 500 && Atomics.load(signal, 0) !== 2; index++) update(`v${index}`)
db.close()
parentPort?.postMessage("done")
