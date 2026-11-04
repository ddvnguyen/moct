import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { agentTaskSnapshotOptions } from "../fork";
import { setAgentTasks } from "./steer-store";

/**
 * Feed the composer takeover's ownership map from the workspace snapshot.
 * Renders nothing.
 *
 * One query, on the key every presence surface already reads: the task events
 * that change a run's lifecycle invalidate it (`use-realtime-sync.ts`), so the
 * map follows a start, a stop and a completion without a poller of its own.
 * This is also the only fetch the takeover costs — the shell-side component
 * reads the store, never the network.
 */
export function SteerReporter({ workspaceId }: { workspaceId: string }): null {
  const { data } = useQuery(agentTaskSnapshotOptions(workspaceId));

  useEffect(() => {
    // Nothing has resolved yet: keep the map as it is rather than reading "no
    // data" as "no runs", which would drop a live takeover for one render.
    if (data === undefined) return;
    setAgentTasks(data);
  }, [data]);

  return null;
}
