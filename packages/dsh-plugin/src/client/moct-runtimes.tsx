import { RuntimesPage, Server } from "../fork";

/**
 * The Runtimes settings page (M-174).
 *
 * The desktop reaches runtimes from its sidebar; a dsh panel has no navigation
 * for it, so the page joins Settings in the slot the fork reserves for
 * host-supplied device pages (`extraDeviceTabs`, the same one the desktop fills
 * with Daemon and Updates). It renders the shared `@multica/views/runtimes`
 * page rather than a second runtimes surface, so a runtime managed in the panel
 * and one managed on the desktop are the same records.
 *
 * The desktop's own wrapper forwards daemon state its main process owns
 * (`localDaemonId`, `bootstrapping`); a panel has no local daemon, so those
 * props stay unset and the page reads what the workspace actually reports.
 */
export const runtimesDeviceTab = {
  value: "runtimes",
  label: "Runtimes",
  icon: Server,
  content: <RuntimesPage />,
};
