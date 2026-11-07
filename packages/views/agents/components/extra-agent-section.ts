import type { ReactNode } from "react";
import type { Agent } from "@multica/core/types";

/**
 * A whole top-level section a host appends beside the agent page's own body.
 *
 * The host owns the label and the content because it is describing its own
 * plane (a memory service, a transport) that the agent page knows nothing
 * about; the page owns only where the section sits, how it is opened, and the
 * rail it aligns to — the same division `ExtraSettingsGroup` sets up for the
 * settings page.
 *
 * This lived in `agent-overview-pane.tsx` until upstream v0.8.1 replaced the
 * tabbed pane with the object page. The contract is a fork API (the dsh island
 * passes sections built by `createAgentMemorySections`), so it moved here with
 * its meaning intact: `id` is still the `?view=` value that opens the section.
 */
export interface ExtraAgentSection {
  /** The `?view=` value that opens the section, unique among the sections. */
  id: string;
  /** The tab's label, host-owned like the group it mirrors. */
  label: string;
  render: (agent: Agent) => ReactNode;
}
