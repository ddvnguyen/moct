# @multica/dsh-plugin

A DeepSeek Harness client plugin that renders Multica's issues, agents, skills,
inbox and chat in the shell's `main` column, with one rail row per view in the
sidebar.

Two halves, one package:

| Face | Entry | Runs in | Owns |
| --- | --- | --- | --- |
| host | `src/index.ts` | the dsh process | `/multica` HTTP + WebSocket transport, and the `/moct` memory seam |
| client | `src/client/index.ts` | the dsh browser shell | six rail rows, their `main` seats, the React 19 island |

The host half exists so the Multica credential never leaves the dsh process: the
island calls `/multica/api/*` on its own origin, the host half forwards to the
Multica server named in the plugin config, and the browser sees neither the
server URL nor the token. Same origin means no CORS, and a WebSocket goes through
`/multica/ws` on the same seam.

`/moct` is the same idea for the memory plane, but closed: moct-be has no auth
and trusts whoever names a workspace, so the host serves a fixed allow-list of
memory routes and injects `workspaceId`, `expertId` and `actor` itself. A route
the panel does not need is a 404 that never reaches the backend; see
[`docs/moct-seam.md`](../../docs/moct-seam.md) and
the config comment in [`cordis.patch.yml`](cordis.patch.yml).

## Configure

The plugin is a normal dsh host row, declared in
[`cordis.patch.yml`](cordis.patch.yml):

```yaml
- id: multica-dsh-plugin
  name: '@multica/dsh-plugin'
  config:
    serverUrl: http://127.0.0.1:8080
    token: ''
    workspaceSlug: ''
```

`token` may be left empty and supplied as `MULTICA_DSH_TOKEN` in the dsh process
instead, which is the option to prefer on a shared machine. `workspaceSlug` empty
selects the first workspace the token can read.

A row that is missing either value still mounts: `/multica/config` reports the
reason, and the panel says what is missing instead of the rail row disappearing.

## The sidebar menu

Six rail rows, one per Multica view. Each row is a `sidebar.panellist` entry
with its own list id, and each id addresses a `main` cell of the same key — that
pairing is how dsh turns "select this row" into "render this panel", so the menu
is six rows rather than a dropdown the plugin would have to position inside
someone else's column.

| Row | Opens |
| --- | --- |
| Multica Issues | the board, and one issue at `issues/<id>` |
| Multica Agents | the agent registry, and one agent at `agents/<id>` |
| Multica Skills | skill management, and one skill at `skills/<id>` |
| Multica Inbox | the question/approval inbox an agent's `ask` and plan reviews land in |
| Multica Chat | the chat view, thread selection in `?session=` |
| Multica Settings | the fork's settings page, with the MOCT group added and the web-only groups hidden |

Each entry opens the fork's own page for that surface, under the same
`CoreProvider`; nothing is re-implemented and nothing is outlined in an iframe.
The island's router maps those six families of workspace path (plus the detail
depth above) and refuses everything else, so a shared component cannot open a
surface the panel does not own.

Settings is the fork's page with two additive props: `hiddenTabs` drops the
pages this shell cannot render (billing, GitHub hosting, messaging channels,
plugins, connected apps, the shortcut reference — the island swallows key
events before the fork sees them), and `extraGroups` appends the one group that
only exists in dsh. Hidden pages leave the navigation, the compact selector and
the search index together, so no result lands on a page that is not there.

The MOCT group is that one dsh-only group. Its **Memory** tab (S2-D) is the
workspace's memory overview: the plane's health, its schema and where the
always-load context budget is spent (S2-B), then the records themselves —
filtered and searched by the seam's own parameters (type, status, home,
keyword) and, on this page, by agent — with one record's versions and the two
decisions a human makes about a pending one, **Approve** and **Reject** (moct's
`approve` and `retract`; the seam has no `reject` verb). It opens on pending
records, which is the queue that needs a human, and it writes nothing else: a
record's text belongs to its writer. Its **Connection** tab (S2-C) shows how the
panel is wired, whether
moct-be answers, and whether a run gets the pre-run memory block; that switch is
the panel's first write, and it is rendered from the server's answer — including
`editable`, which the server derives from the reader's workspace role, so a
member sees the state and an owner/admin edits it. Its **Interactions** tab
(S2-C) holds the ask/plan wait: a workspace default (ten minutes) with a
per-project override. The wait is stored and surfaced only — nothing in this
panel cancels a parked run or resumes one.

The row chooses where an island *opens*; from there the fork's pages navigate as
they do in the web app — an inbox row that no longer resolves falls back to its
issue, for instance — and the row keeps marking the entry the reader came
through. dsh gives a plugin no way to move the shell's rail selection, so the
island follows the reader, and moves the rail's selection with it (see
"Keeping the shell in step" below).

Not mapped: the creation flows (`agents/new`, the AI builder). They are real
routes in the fork, but they are authoring surfaces rather than views of what
already exists, so a "New agent" click logs one line and stays put rather than
opening a page this cut does not cover.

## Header tabs

The island carries its own header row above the page: back/forward buttons, a
horizontally scrolling tab strip, and an empty trailing slot reserved for card
B. Every MMX view (board, issue, agents, agent, skills, skill, inbox, chat,
settings) opens as a tab. A rail click focuses that family's tab (or opens
one), and closing the last tab opens the family root so the strip is never
empty. The board's own title `PageHeader` is suppressed when the island hosts
the chrome (`PageChromeProvider`), while its filter toolbar stays.

Back and Forward are **one history for the whole window**, not one per tab
(`src/client/tabs.ts`). A tab switch and a navigation inside a tab each record
a visited location; the history stores which tab each location belonged to and
is saved with the tabs (session), capped at 100. Back from a tab's first
location therefore lands on the previous tab's last one, and the entries of a
tab closed since are skipped rather than pruned.

An issue tab is named by its identifier (`M-123`) with the full title in its
tooltip; while the issue is still loading the name falls back to the URL's own
segment, which the issue route rewrites to the identifier once it resolves.
Every other tab keeps the name the fork resolves for it.

### The dsh side panel

The header carries one more control than the strip: dsh's own right-Sidebar
toggle, next to the tabs. It is the shell's column, not a Multica view — a press
flips the panel dsh draws, with its own tabs, Start guide and collapse — and it
addresses the selected project's `local_directory` resource ("All projects"
uses the host's `workspaceFolder`). A project with no folder disables it with
the copy that says what is missing.

Which Session the column edits is the project's, not whatever the Conversation
last selected: on a host that can host the column beside MMX (card C's
`hostPanel` and `selectHostedSession`), a press names the folder's Session and
flips the column in place, so the board never leaves the main column. A host
without that opt-in puts the folder's Session on screen first and opens the
column there, which is the only place its Sidebar can be drawn. An open column
is closed where it is, and a press that cannot proceed reports why in the
tooltip.

## Keeping the shell in step

The rail and the strip are two views of one state, so the island tells the
shell which row is showing (`src/client/shell.ts`, through dsh's `ctx.layout`):
whatever moves the active tab — a tab click, Back/Forward across tabs, closing
the current tab, a restored session — also selects the rail row that owns the
tab's family. Only a seated island does this; the warm-up build has no seat and
leaves the shell's selection alone.

The same module collapses the sidebar while an MMX view is active and gives the
reader back the sidebar they had on leaving (`ctx.layout.toggleSidebar`, with
the collapsed state read from the frame's own `data-sidebar-collapsed`). A
sidebar that was already collapsed is left alone, and one the reader expands
inside MMX is never collapsed again for them: the collapse happens once, on
entering, and only that collapse is undone on leaving.

## How it renders

`dsh.client` declares the client bundle, and dsh fetches it as one classic script.
That bundle contains its own React 19 and React DOM — the shell's React 18 never
renders island components, and the island never calls a shell hook. The two trees
meet at exactly one element per component: the shell creates it with its own
`createElement`, and the island takes over everything inside it.

Inside is a shadow root. The fork's stylesheet is compiled to one string, `:root`
is rewritten to `:host`, and the result is attached to the shadow root — so
Tailwind's preflight, the fork's design tokens and its utility classes cannot
reach dsh's document, and dsh's CSS cannot reach in. Overlays (dialogs, menus,
tooltips, popovers) render into a portal seat *outside* that shadow root — the
shell's own `[data-shell-overlay]` layer when it has one, otherwise a seat the
island puts on the document — and the seat carries its own copy of the
stylesheet, so they stay styled without sitting in the panel's stacking context.

They must stay out of the panel: Base UI decides whether a press was "outside" by
walking up from the pressed element, and that walk stops at a shadow boundary. A
popup rendered inside the panel therefore never saw a press in the panel as
outside, and any inert marker Base UI had put on the page read as post-render
content — two pickers stacked, Escape ignored, outside presses dropped (M-148).
`src/client/popup-seat.ts` owns that boundary, including moving the seat into
dsh's overlay layer when the shell mounts it after the plugin's warm-up.

One thing a shadow root cannot carry is Tailwind v4's `@property` rules:
Chromium does not register them from a stylesheet inside a shadow tree, so every
utility reading an unset `--tw-*` — `border`, `shadow-*`, `ring-*`, the gradient
stops — computes to nothing there. They are therefore extracted from the
compiled stylesheet at build time (`scripts/island-property-rules.mjs`) and
registered once on the shell's document by `startIsland`
(`src/client/property-shim.ts`); registration is document-wide, so it serves the
panel, the popup seat and any tree between them.

Seat and host share one inline box (`SEAT_STYLE` in
[`src/client/island.ts`](src/client/island.ts)): full width and height of the
main column. That is what makes the island's `height: 100%` resolve against a
definite parent, so a page fills the column instead of collapsing to its
content height (M-143).

There is no iframe and no loopback page: the board, the filters, the issue page
and the other four views are the fork's own components, mounted under a fork
`CoreProvider` whose `ApiClient` points at `/multica`.

The one workspace the panel speaks as is set on the platform's
current-workspace pointer *before* any page mounts: the gate arms itself in a
layout effect and renders its children only once the pointer matches the
workspace it resolved. A passive effect there would be too late — child effects
run before the parent's — so the first queries of a load went out without
`X-Workspace-Slug` and the server answered 400 to each until react-query
retried (M-198). The rail dot's poller takes its slug from the host's own boot
config for the same reason (it runs before any island exists), and a host with
no workspace configured is not polled at all.

What the plugin may import from the fork is deliberately narrow — see
[`FORK.md`](FORK.md). One module, public exports only, enforced by `pnpm lint`.

## Hide, do not delete

Surfaces that do not belong in the harness panel — GitHub/Slack integrations,
billing, autopilots, squads — are hidden in the island. They are not removed from
the fork and remain reachable from the Multica web app.

## Develop

```sh
pnpm --filter @multica/dsh-plugin build     # tsc for the host half, then the client bundle
pnpm --filter @multica/dsh-plugin test      # proxy, gate, seat, island and storage tests
pnpm --filter @multica/dsh-plugin test:e2e  # the Chromium harness suite (needs a Playwright browser)
pnpm --filter @multica/dsh-plugin lint      # eslint + the fork-entry gate
pnpm --filter @multica/dsh-plugin typecheck
```

`build` writes `lib/index.js` (host) and `lib/client.js` (the wrapped client
bundle). The client bundle is generated, not hand-edited: `scripts/wrap-client.mjs`
wraps the Vite output in the module-loader preamble dsh expects.

## The parity harness

`e2e/island-parity.spec.ts` is the acceptance gate for the island's UI: it
renders the same fixtures twice, once with the fork's stylesheet in the document
(how upstream Multica web serves it, where the browser registers Tailwind's
`@property` rules itself) and once through the production boundary — shadow
roots, popup seat, document-level property shim — and compares computed styles.
Both renderings come from the same commit and the same compiled CSS, so a
difference is the shadow-DOM defect, not version skew.

`e2e/parity/targets.ts` names the surfaces and the elements judged on each one:
board, issue page, create-issue dialog, dropdown menu, status popover, toast,
command palette, plus a set of mechanism boxes covering `translate`/`rotate`/
`scale`, `blur`, `ring`, gradients and `space-*` — the utilities whose values
Tailwind v4 derives from `--tw-*` initial values. Every surface is measured in
light and dark at 1440×1300. The toast is sonner's own recipe built from the
same primitives: the island mounts no `Toaster`, so there is no live toast to
compare.

`e2e/island-interactions.spec.ts` covers the behaviours a style comparison
cannot see: Escape closing only the top layer, an outside click closing a menu,
a dialog opened from a menu closing it, Tab staying inside an open dialog, and
keystrokes in a dialog input never reaching dsh's own shortcuts. It drives
`/parity.html?mode=island` — the harness page with a fake shell that records what
its document-level key handler receives.

The suite found two behaviours beyond the styling:

- a dialog's keystrokes reached the shell, because a dialog is portalled into the
  popup seat rather than rendered under the panel's guard (`swallowShellShortcuts`
  now also runs on the portal container);
- Tab left an open dialog, because Base UI's focus guards compare
  `document.activeElement` with themselves and inside a shadow tree that is the
  host, so the guards never fired (`src/client/focus-guards.ts`);
- popups stayed stacked and could not be dismissed, a second finding with the
  same cause and its own suite, `e2e/island-popups.spec.ts`: it drives the
  Runtime → Model picker sequence in all three overlay-layer arrangements and
  asserts one layer at a time, Escape closing the top layer, an outside click
  closing it, and tooltips that come and go with the pointer.

The harness runs against the dev server; `?mode=reference|island`, `?theme=light|dark`,
`?shim=off` and `?seat=off|late` are the switches. `?shim=off` is what
`island-parity.spec.ts` uses to prove the gate could fail: without the shim the
island's borders and shadows are `none` again. `?seat=off` removes the shell's
overlay layer before the island is built and `?seat=late` keeps it out until the
spec mounts it, which are the two arrangements lane z hit.

## The host half ships as emitted

dsh imports `lib/*.js` as bare Node ESM, so the compiled output has to be
loadable without a bundler or a post-processing step:

- relative imports are written with their extension (`./proxy.js`), which tsc
  resolves to the `.ts` source and emits verbatim;
- `ws` is loaded through [`src/ws.ts`](src/ws.ts) — `createRequire` at module
  scope — because it is CommonJS-only and the host's conditions can otherwise
  select its browser build, which has no `WebSocketServer`.

Both constraints fail at dsh boot, not at build, which is why the lane's bundle
script loads the emitted entry as ESM before it ships it.
