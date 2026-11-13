/**
 * Transport interfaces: where serialised log lines go.
 *
 * @module
 */

/** A batch of complete NDJSON lines that all belong to one UTC day. */
export interface Batch {
  readonly text: string
  readonly bytes: number
  readonly records: number
  readonly dayKey: string
}

/**
 * A log destination. `write` resolves once the batch has been handed to the OS, or rejects. The
 * logger never calls `write` again before the previous call has settled, so implementations need
 * no locking.
 */
export interface Transport {
  readonly name: string
  write(batch: Batch): Promise<void>
  /** Release resources (open files). Idempotent. */
  close(): Promise<void>
}

/** A low-level append-only writer for one open file. */
export interface FileWriter {
  append(text: string, bytes: number): Promise<void>
  close(): Promise<void>
}

/** Opens a {@link FileWriter} for a path (injectable, so tests can simulate disk failures). */
export type FileWriterFactory = (path: string) => Promise<FileWriter>

/** Anything with a `write(string)` method, such as `process.stdout`. */
export interface WritableLike {
  write(chunk: string): unknown
}
