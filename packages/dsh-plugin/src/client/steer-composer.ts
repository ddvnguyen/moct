import { ISLAND_API_BASE, islandConfig } from "./config";
import type { HostCreateElement } from "./seat";
import {
  addQueued,
  queuedFor,
  selectOwnedSession,
  subscribe,
  type OwnedSession,
  type QueuedSupplement,
} from "./steer-store";

/**
 * The composer the dsh chat shows for an MMX-owned session (M-136).
 *
 * The shell drives this component with its own React 18, and every hook in this
 * package belongs to the bundled React 19, so this file is hook-free on
 * purpose: the component renders one host `div` and a stable ref builds the
 * composer as plain DOM. State changes arrive two ways — the store's own
 * subscription repaints the queue and the run header, and typing is local to
 * the textarea — so nothing here needs a React state or a second render pass.
 *
 * What it is, in the shell's vocabulary: the session controller's follow-up
 * composer, with our backend behind it. A follow-up always queues ("Queue —
 * next turn"); Steer is the explicit send-now action. Stop reuses the run row's
 * confirm — a second
 * click, not a dialog and not a keyboard binding — because a stop is a
 * destructive action that must never fire on a stray key.
 *
 * Writes go to the Multica API through the host's proxy, exactly like the
 * island's own requests (`config.ts`): same-origin, cookie-authenticated by the
 * host, workspace named by the header the host configured. No token is read or
 * stored here; anyone who can open this dsh session acts as the proxy token
 * owner, which the PR states plainly.
 */

const FRAME_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "10px 12px",
  border: "1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.35))",
  borderRadius: "10px",
  background: "var(--dsw-alias-surface-secondary, transparent)",
  color: "inherit",
  font: "inherit",
  fontSize: "13px",
} as const;

const HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  minWidth: 0,
} as const;

const MUTED_STYLE = {
  color: "var(--dsw-alias-text-tertiary, currentColor)",
  opacity: 0.75,
  fontSize: "11px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const SPACER_STYLE = { flex: "1 1 auto", minWidth: "0" } as const;

const TEXTAREA_STYLE = {
  width: "100%",
  minHeight: "56px",
  maxHeight: "160px",
  resize: "none",
  border: "0",
  outline: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: "13px",
  lineHeight: "1.45",
  padding: "0",
} as const;

const ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  minWidth: 0,
  fontSize: "12px",
} as const;

const BUTTON_STYLE = {
  flex: "0 0 auto",
  height: "26px",
  padding: "0 9px",
  borderRadius: "6px",
  border: "1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.35))",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: "12px",
  cursor: "pointer",
} as const;

const PRIMARY_BUTTON_STYLE = {
  ...BUTTON_STYLE,
  borderColor: "transparent",
  background: "var(--dsw-alias-state-business-primary, #4f7cff)",
  color: "var(--dsw-alias-surface-primary, #fff)",
} as const;

const DANGER_BUTTON_STYLE = {
  ...BUTTON_STYLE,
  borderColor: "transparent",
  background: "var(--dsw-alias-state-error-primary, #d64545)",
  color: "var(--dsw-alias-surface-primary, #fff)",
} as const;

/** The chain's owner props this component reads. */
export interface SteerComposerProps {
  /** The dsh session the shell is rendering; the store keys ownership on it. */
  sessionId?: string | undefined;
  /** Elected turn, injected by the chain (`ChainSelect` result). */
  matched?: OwnedSession | undefined;
}

/**
 * The `conversation.composer` entry `apply` registers.
 *
 * Exported so a harness can elect it the way the shell does without booting
 * the plugin's island: the selector and the priority are the contract, and a
 * second copy of them would be a second contract.
 *
 * `priority: 0` sits above ui-subagent's read-only entry (-10) — a subagent
 * session is never MMX-owned, so the two never contend — and below the
 * pending-interaction entries (1), which must keep the composer while the
 * agent is asking a question. Anything that declines here falls through to the
 * shell's own composer untouched.
 */
export const STEER_COMPOSER_ENTRY = {
  name: "conversation.composer",
  priority: 0,
  select: (owner: unknown): OwnedSession | null =>
    selectOwnedSession((owner as { sessionId?: string }).sessionId),
} as const;

/**
 * Build the composer component for one registration.
 *
 * Created once per `slots.register`, like every component in `seat.ts`: the ref
 * identity has to survive re-renders or React would detach and rebuild the DOM
 * on each one. The session id is written into this closure on every render and
 * read once at mount, because the shell passes it as a prop and the ref has no
 * props of its own.
 */
export function createSteerComposer(createElement: HostCreateElement) {
  let sessionId: string | undefined;
  let mounted: ComposerHandle | null = null;

  const ref = (node: HTMLElement | null): void => {
    if (node !== null) {
      mounted = mountComposer(node, sessionId ?? "");
      return;
    }
    mounted?.dispose();
    mounted = null;
  };

  return function MulticaSteerComposer(props: SteerComposerProps) {
    sessionId = props.sessionId;
    return createElement("div", { ref, "data-multica-steer-composer": "" });
  };
}

interface ComposerHandle {
  dispose(): void;
}

/**
 * Build the composer inside the host element.
 *
 * Everything below is plain DOM. The frame is painted from the store on every
 * change, the draft and the in-flight flags live in this closure, and the only
 * thing React ever sees is the empty host element.
 */
function mountComposer(host: HTMLElement, sessionId: string): ComposerHandle {
  const doc = host.ownerDocument;
  const frame = doc.createElement("div");
  Object.assign(frame.style, FRAME_STYLE);

  const header = doc.createElement("div");
  Object.assign(header.style, HEADER_STYLE);
  const title = doc.createElement("span");
  title.textContent = "Multica run";
  title.style.fontWeight = "600";
  const runId = doc.createElement("span");
  Object.assign(runId.style, MUTED_STYLE);
  const spacer = doc.createElement("span");
  Object.assign(spacer.style, SPACER_STYLE);
  header.append(title, runId, spacer);

  const stopButton = doc.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "Stop";
  Object.assign(stopButton.style, BUTTON_STYLE);
  header.append(stopButton);

  const confirmRow = doc.createElement("div");
  Object.assign(confirmRow.style, ROW_STYLE);
  confirmRow.style.display = "none";
  const confirmText = doc.createElement("span");
  confirmText.textContent = "Stop this run?";
  Object.assign(confirmText.style, MUTED_STYLE);
  confirmText.style.whiteSpace = "normal";
  const confirmSpacer = doc.createElement("span");
  Object.assign(confirmSpacer.style, SPACER_STYLE);
  const confirmYes = doc.createElement("button");
  confirmYes.type = "button";
  confirmYes.textContent = "Stop";
  Object.assign(confirmYes.style, DANGER_BUTTON_STYLE);
  const confirmNo = doc.createElement("button");
  confirmNo.type = "button";
  confirmNo.textContent = "Cancel";
  Object.assign(confirmNo.style, BUTTON_STYLE);
  confirmRow.append(confirmText, confirmSpacer, confirmNo, confirmYes);

  const queueRows = doc.createElement("div");
  Object.assign(queueRows.style, { display: "flex", flexDirection: "column", gap: "4px" });

  const textarea = doc.createElement("textarea");
  textarea.rows = 2;
  textarea.placeholder = "Message this run…";
  Object.assign(textarea.style, TEXTAREA_STYLE);
  textarea.setAttribute("aria-label", "Message this run");

  const footer = doc.createElement("div");
  Object.assign(footer.style, ROW_STYLE);
  const hint = doc.createElement("span");
  hint.textContent = "Queue — next turn";
  Object.assign(hint.style, MUTED_STYLE);
  const footerSpacer = doc.createElement("span");
  Object.assign(footerSpacer.style, SPACER_STYLE);
  const steerButton = doc.createElement("button");
  steerButton.type = "button";
  steerButton.textContent = "Steer";
  Object.assign(steerButton.style, BUTTON_STYLE);
  const queueButton = doc.createElement("button");
  queueButton.type = "button";
  queueButton.textContent = "Queue";
  Object.assign(queueButton.style, PRIMARY_BUTTON_STYLE);
  footer.append(hint, footerSpacer, steerButton, queueButton);

  const status = doc.createElement("div");
  Object.assign(status.style, { ...MUTED_STYLE, whiteSpace: "normal", minHeight: "14px" });

  frame.append(header, confirmRow, queueRows, textarea, footer, status);
  host.append(frame);

  let task: OwnedSession | null = null;
  let sending = false;
  let stopping = false;
  let confirmStop = false;

  const paint = (): void => {
    task = selectOwnedSession(sessionId);
    if (task === null) {
      // The turn ended while this composer was elected. The shell re-elects on
      // its next composer render; until then this is honest and inert rather
      // than a box that swallows a message.
      frame.style.opacity = "0.6";
      runId.textContent = "";
      textarea.disabled = true;
      textarea.placeholder = "This run has ended.";
      steerButton.disabled = true;
      queueButton.disabled = true;
      stopButton.style.display = "none";
      confirmRow.style.display = "none";
      queueRows.replaceChildren();
      return;
    }

    frame.style.opacity = "1";
    runId.textContent = `#${task.taskId.slice(0, 8)}`;
    textarea.disabled = sending;
    steerButton.disabled = sending || textarea.value.trim() === "";
    queueButton.disabled = sending || textarea.value.trim() === "";
    confirmRow.style.display = confirmStop ? "flex" : "none";
    stopButton.style.display = confirmStop ? "none" : "";
    stopButton.disabled = stopping;
    stopButton.textContent = stopping ? "Stopping…" : "Stop";
    paintQueued(task);
  };

  const paintQueued = (owner: OwnedSession): void => {
    queueRows.replaceChildren();
    const rows = queuedFor(owner.taskId);
    if (rows.length === 0) return;
    for (const row of rows) {
      queueRows.append(queuedRow(doc, row));
    }
  };

  const queuedRow = (doc: Document, row: QueuedSupplement): HTMLElement => {
    const line = doc.createElement("div");
    Object.assign(line.style, ROW_STYLE);
    const text = doc.createElement("span");
    text.textContent = row.content;
    Object.assign(text.style, {
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    const state = doc.createElement("span");
    state.textContent = queuedLabel(row);
    Object.assign(state.style, MUTED_STYLE);
    const lineSpacer = doc.createElement("span");
    Object.assign(lineSpacer.style, SPACER_STYLE);
    line.append(text, lineSpacer, state);
    return line;
  };

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const send = async (mode: "steer" | "queue"): Promise<void> => {
    const content = textarea.value.trim();
    const owner = task;
    if (content === "" || sending || owner === null) return;
    sending = true;
    setStatus("");
    paint();
    try {
      const created = await postSupplement(owner, content, mode);
      textarea.value = "";
      if (mode === "queue") {
        addQueued({
          commentId: created.commentId,
          taskId: owner.taskId,
          content,
          mode: "queue",
          status: created.status,
        });
        setStatus("Queued for the next turn");
      } else {
        setStatus("Sent to the running turn");
      }
    } catch (error) {
      // The draft stays: a refused or failed send is retried from here.
      setStatus(errorMessage(error, "Could not send the message"));
    } finally {
      sending = false;
      paint();
    }
  };

  const stop = async (): Promise<void> => {
    const owner = task;
    if (stopping || owner === null) return;
    stopping = true;
    confirmStop = false;
    paint();
    try {
      await postStop(owner);
      setStatus("Stop requested");
    } catch (error) {
      setStatus(errorMessage(error, "Could not stop the run"));
    } finally {
      stopping = false;
      paint();
    }
  };

  const onInput = (): void => {
    paint();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) void send("steer");
    else void send("queue");
  };

  const onStopClick = (): void => {
    confirmStop = true;
    paint();
  };
  const onConfirmYes = (): void => {
    void stop();
  };
  const onConfirmNo = (): void => {
    confirmStop = false;
    paint();
  };
  const onSteerClick = (): void => {
    void send("steer");
  };
  const onQueueClick = (): void => {
    void send("queue");
  };

  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeyDown);
  stopButton.addEventListener("click", onStopClick);
  confirmYes.addEventListener("click", onConfirmYes);
  confirmNo.addEventListener("click", onConfirmNo);
  steerButton.addEventListener("click", onSteerClick);
  queueButton.addEventListener("click", onQueueClick);

  const unsubscribe = subscribe(paint);
  paint();

  return {
    dispose(): void {
      unsubscribe();
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("keydown", onKeyDown);
      stopButton.removeEventListener("click", onStopClick);
      confirmYes.removeEventListener("click", onConfirmYes);
      confirmNo.removeEventListener("click", onConfirmNo);
      steerButton.removeEventListener("click", onSteerClick);
      queueButton.removeEventListener("click", onQueueClick);
      frame.remove();
    },
  };
}

/** The one label a queued row shows: what the server has done with it so far. */
function queuedLabel(row: QueuedSupplement): string {
  if (row.mode === "steer") {
    return row.status === "pending" ? "steered — delivering" : `steered — ${row.status}`;
  }
  if (row.status === "pending") return "queued — next turn";
  if (row.status === "delivered") return "delivered";
  if (row.status === "failed") return "failed";
  return row.status;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

/** Workspace header the host proxy resolves every island request by. */
async function workspaceHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept: "application/json" };
  try {
    const slug = (await islandConfig()).workspaceSlug.trim();
    if (slug !== "") headers["X-Workspace-Slug"] = slug;
  } catch {
    // A config read that fails leaves the header off; the server answers 400
    // and the composer shows that, which is better than inventing a workspace.
  }
  return headers;
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && "error" in body) {
      const error = (body as { error: unknown }).error;
      if (typeof error === "string" && error.trim() !== "") return error;
    }
  } catch {
    // Fall through to the status line.
  }
  return `Request failed (${response.status})`;
}

/** A `client_request_id` the server can dedupe a double submit by. */
function requestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface CreatedSupplement {
  commentId: string;
  status: string;
}

async function postSupplement(
  task: OwnedSession,
  content: string,
  mode: "steer" | "queue",
): Promise<CreatedSupplement> {
  const response = await fetch(
    `${ISLAND_API_BASE}/api/issues/${task.issueId}/tasks/${task.taskId}/supplements`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { ...(await workspaceHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ content, client_request_id: requestId(), mode }),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as {
    id?: unknown;
    supplements?: { task_id?: unknown; status?: unknown }[];
  };
  const commentId = typeof body.id === "string" ? body.id : "";
  if (commentId === "") throw new Error("The message was accepted without a receipt");
  const receipt = body.supplements?.find((row) => row.task_id === task.taskId);
  const status = typeof receipt?.status === "string" ? receipt.status : "pending";
  return { commentId, status };
}

async function postStop(task: OwnedSession): Promise<void> {
  const response = await fetch(
    `${ISLAND_API_BASE}/api/issues/${task.issueId}/tasks/${task.taskId}/cancel`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: await workspaceHeaders(),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
}
