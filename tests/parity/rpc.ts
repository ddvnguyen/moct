/** Raw JSON-RPC stdio client for parity driving (no SDK validation). */
import { spawn, type ChildProcess } from "node:child_process";

export class RpcClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private pending = new Map<number, (msg: unknown) => void>();
  private nextId = 1;

  constructor(
    private readonly cmd: string,
    private readonly argv: string[],
    private readonly opts: { cwd: string; env: Record<string, string | undefined> },
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.cmd, this.argv, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          // notifications / log lines are ignored
        }
      }
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  send(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload =
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params };
    this.proc!.stdin!.write(JSON.stringify(payload) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, 60000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const payload =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.proc!.stdin!.write(JSON.stringify(payload) + "\n");
  }

  async initialize(): Promise<Record<string, unknown>> {
    const res = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fleet-parity", version: "1" },
    });
    this.notify("notifications/initialized");
    await new Promise((r) => setTimeout(r, 200));
    return res;
  }

  async listTools(): Promise<Record<string, unknown>> {
    return this.send("tools/list", {});
  }

  async callTool(name: string, args?: unknown): Promise<Record<string, unknown>> {
    const params = args === undefined ? { name } : { name, arguments: args };
    return this.send("tools/call", params);
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }
}
