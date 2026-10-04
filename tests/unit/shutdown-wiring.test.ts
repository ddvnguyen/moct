/**
 * Shutdown wiring (F8): every exit path must close fleet.db.
 *
 * The regression this guards is a DROPPED LINE, not wrong logic: with the
 * handlers inline in an auto-executing `main()`, deleting
 * `transport.onclose = ...` fails no test and leaves the process holding the
 * Turso lock after stdin-EOF. `wireShutdown` exists so that line is reachable.
 */
import { describe, expect, it, vi } from "vitest";
import { wireShutdown } from "../../src/mcp.js";

/** Let the fire-and-forget shutdown promise settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(closeImpl?: () => Promise<void>) {
  const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  if (closeImpl) close.mockImplementation(closeImpl);
  const exit = vi.fn();
  const signals: Record<"SIGTERM" | "SIGINT", () => void> = {
    SIGTERM: () => undefined,
    SIGINT: () => undefined,
  };
  const transport: { onclose?: (() => void) | null } = {};
  wireShutdown(
    transport,
    { close },
    {
      exit,
      registerSignal: (signal, handler) => {
        signals[signal] = handler;
      },
    },
  );
  return { close, exit, signals, transport };
}

describe("wireShutdown", () => {
  it("closes the store and exits 0 when the transport closes (stdin-EOF)", async () => {
    const { close, exit, transport } = harness();
    expect(typeof transport.onclose).toBe("function");
    transport.onclose!();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closes the store and exits 0 on SIGTERM and SIGINT", async () => {
    const term = harness();
    term.signals.SIGTERM();
    await flush();
    expect(term.close).toHaveBeenCalledTimes(1);
    expect(term.exit).toHaveBeenCalledWith(0);

    const int = harness();
    int.signals.SIGINT();
    await flush();
    expect(int.close).toHaveBeenCalledTimes(1);
    expect(int.exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when close() rejects (best-effort, never stranded)", async () => {
    const { close, exit, transport } = harness(async () => {
      throw new Error("close failed");
    });
    transport.onclose!();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
