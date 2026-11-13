/**
 * Flush logs on shutdown without ever blocking it (RFC-0004 §6, ADR-0015).
 *
 * - **`SIGTERM` / `SIGINT`:** drain with a deadline, then exit with 128 + the signal number
 *   (143 for SIGTERM). Installing a signal listener disables Node's default "exit immediately",
 *   so this module exits explicitly.
 * - **`beforeExit`:** the event loop is empty. Drain once, bounded.
 *
 * **Windows note** (proven in spike 09): an external `SIGTERM` on Windows terminates the process
 * outright, so it can't be caught and nothing can flush. Graceful shutdown there goes through
 * the framework, which calls `logger.flush()` before exiting. Linux containers receive a real
 * `SIGTERM`, which this handles.
 *
 * @module
 */
import type { StrutvaneLogger } from './logger.ts'

/** Options for {@link registerShutdownFlush}. */
export interface ShutdownOptions {
  /** Maximum time to wait for logs to drain. Default: 2,000 ms. */
  readonly timeoutMs?: number
  /** Signals to handle. Default: `SIGTERM`, `SIGINT`. */
  readonly signals?: readonly NodeJS.Signals[]
  /** Exit after draining on a signal. Default: `true`. Set `false` when the host app exits itself. */
  readonly exitOnSignal?: boolean
}

const SIGNAL_NUMBERS: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
}

/**
 * Drain `logger` on shutdown signals and on `beforeExit`.
 *
 * @returns a function that removes the listeners again
 */
export function registerShutdownFlush(
  logger: StrutvaneLogger,
  options: ShutdownOptions = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? 2_000
  const signals = options.signals ?? ['SIGTERM', 'SIGINT']
  let flushing = false

  const onSignal = (signal: NodeJS.Signals): void => {
    if (flushing) return
    flushing = true
    const code = 128 + (SIGNAL_NUMBERS[signal] ?? 0)
    let exited = false
    const exit = (): void => {
      if (exited || options.exitOnSignal === false) return
      exited = true
      process.exit(code)
    }
    // A REF'D deadline timer keeps the process alive while draining. Without it, a transport whose
    // promise never settles leaves the event loop empty. Node would then exit on its own with code
    // 0 and the signal's exit code would be lost (found by spike 09).
    const deadline = setTimeout(exit, timeoutMs)
    logger
      .drain(timeoutMs)
      .catch(() => ({ flushed: false, pending: -1 }))
      .then((result) => {
        if (result.flushed) {
          clearTimeout(deadline)
          exit()
        }
      })
  }

  let beforeExitDone = false
  const onBeforeExit = (): void => {
    if (beforeExitDone) return
    beforeExitDone = true
    void logger.drain(timeoutMs)
  }

  for (const s of signals) process.on(s, onSignal)
  process.on('beforeExit', onBeforeExit)
  return () => {
    for (const s of signals) process.off(s, onSignal)
    process.off('beforeExit', onBeforeExit)
  }
}
