/**
 * TeamDb — the narrow SQL seam the Team Room store codes against. Like Store,
 * it is implemented ONLY by store/turso-repository.ts, so the Turso driver stays
 * confined to that one file (the turso-import gate). Team writes go through
 * `transaction`, which takes the repository's lock, so they never interleave
 * with a fleet transaction on the shared connection.
 */
export interface TeamDb {
  get(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Consistent copy of the whole database to a new file, taken on the live
   * connection (VACUUM INTO). Runs outside a transaction and serialised with
   * the fleet writers, so a copy never sees a half-written transaction.
   */
  vacuumInto(file: string): Promise<void>;
}
