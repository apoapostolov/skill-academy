declare module 'node:sqlite' {
  export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Record<string, unknown>[]
  }
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): Statement
    close(): void
  }
}
