import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The two dsh contracts this package compiles against, stated structurally.
 *
 * The plugin is loaded by dsh, not linked against it: the host face is handed
 * the real Cordis `ctx`, and the browser face is handed the shell's slot
 * registry. Declaring only the members used here keeps `@deepseek-ai/*` out of
 * this repository's dependency graph while still failing the build if the call
 * shapes drift, and the pinned reference for both is dsh 0.2.0-rc.2
 * (`packages/host/webserver/src/index.ts`, `packages/client/ui-slots`).
 */

/** One named HTTP route a host plugin may add. */
export interface DshHttpRoute {
  /** `exact` matches the pathname verbatim; `prefix` also matches `path/...`. */
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** One exact-path HTTP upgrade route, owned by a single protocol. */
export interface DshUpgradeRoute {
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** What dsh's Connection offers: refuse a request that is not this browser. */
export interface DshConnection {
  requestRejection(request: {
    headers: Record<string, string | string[] | undefined>;
  }): number | undefined;
}

/** The host half of a dsh plugin's context. */
export interface DshHostContext {
  /** Run `fn` under the plugin's lifetime; the returned disposer runs on unload. */
  effect(fn: () => (() => void) | void, label: string): unknown;
  webServer: {
    register(route: DshHttpRoute): () => void;
    registerUpgrade(route: DshUpgradeRoute): () => void;
  };
  /** Present in the shipped Web composition; absent in other hosts. */
  connection?: DshConnection;
}

/** One additive slot registration, in the shape dsh's slot registry takes. */
export interface DshSlotRegistration {
  name: string;
  /** Required for `list` slots, which address cells by id. */
  id?: string;
  /** Required for `keyed` slots, which dispatch on `entryKey`. */
  key?: string;
  order?: number;
  priority?: number;
  label?: string;
  /**
   * Chain-slot selector: return the value this entry is elected for, or `null`
   * to decline. Entries are tried in ascending `priority`; the first non-null
   * result wins and reaches the component as its `matched` prop.
   */
  select?: (owner: unknown) => unknown;
}

/**
 * The layout service's selection source (`ctx.layout.panelInfo`).
 *
 * A `HostObservable` in dsh's own terms: read the snapshot, subscribe to its
 * invalidation. `activePanelId` is the selected rail row, `null` for the
 * Conversation.
 */
export interface DshPanelInfo {
  getSnapshot(): { readonly activePanelId: string | null };
  subscribe(listener: () => void): () => void;
}

/**
 * The layout service (`ctx.layout`, provided by ui-layout).
 *
 * Declared as the three members this plugin calls: the selection source, the
 * panel selection itself, and the sidebar toggle. `selectPanel` throws for a
 * `main` key that is not registered; the island's rail rows are.
 */
export interface DshLayout {
  readonly panelInfo: DshPanelInfo;
  selectPanel(panelId: string | null): void;
  toggleSidebar(): void;
}

/** The browser half of a dsh plugin's context. */
export interface DshClientContext {
  slots: {
    /** Contribute once the slot is live; the callback's effects follow it. */
    inject(key: string, register: () => unknown): unknown;
    register(options: DshSlotRegistration, component: unknown): unknown;
  };
  /**
   * Panel geometry and selection, from dsh's ui-layout. Absent in a host built
   * without it, which leaves the rail agreement and the auto-collapse inert
   * (M-197) instead of failing the panel.
   */
  layout?: DshLayout;
  /**
   * Run `fn` under the plugin's page lifetime, when the shell gives the
   * browser context one (the host face always has it). Optional: the absence
   * reads as "no teardown surface", which only shortens hostPanel's cleanup.
   */
  effect?(fn: () => (() => void) | void, label: string): unknown;
}

/** The module values every dsh client bundle hands to the shell's loader. */
export interface DshClientModule {
  apply(ctx: DshClientContext): void;
  inject: string[];
  default: DshClientModule;
}
