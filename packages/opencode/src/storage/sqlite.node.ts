import { DatabaseSync, type StatementSync } from "node:sqlite"

type Value = string | number | bigint | Uint8Array | null

class Statement<Row, Params extends Value[]> {
  constructor(
    private statement: StatementSync,
    safeIntegers: boolean,
  ) {
    statement.setReadBigInts(safeIntegers)
  }

  all(...params: Params) {
    return this.statement.all(...params) as Row[]
  }

  get(...params: Params) {
    return this.statement.get(...params) as Row | undefined
  }

  iterate(...params: Params) {
    return this.statement.iterate(...params) as IterableIterator<Row>
  }

  run(...params: Params) {
    return this.statement.run(...params)
  }
}

export class Database {
  private database: DatabaseSync

  constructor(path: string, options?: { readonly?: boolean; safeIntegers?: boolean; create?: boolean; strict?: boolean }) {
    this.database = new DatabaseSync(path, {
      readOnly: options?.readonly,
      enableForeignKeyConstraints: false,
      allowExtension: false,
    })
    this.safeIntegers = options?.safeIntegers ?? false
  }

  private safeIntegers: boolean

  query<Row = Record<string, Value>, Params extends Value[] = Value[]>(sql: string) {
    return new Statement<Row, Params>(this.database.prepare(sql), this.safeIntegers)
  }

  run(sql: string) {
    this.database.exec(sql)
  }

  transaction<T>(callback: () => T) {
    return () => {
      this.database.exec("BEGIN")
      try {
        const result = callback()
        this.database.exec("COMMIT")
        return result
      } catch (error) {
        this.database.exec("ROLLBACK")
        throw error
      }
    }
  }

  close() {
    this.database.close()
  }
}
