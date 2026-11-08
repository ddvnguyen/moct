import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../../platform/storage";

/**
 * Reading order of the issue-detail timeline (Activity / Comments).
 *
 * A personal reading preference (like the sub-issue row toggles), not a
 * per-issue setting: every issue's timeline shares the one configuration,
 * persisted globally via `defaultStorage`. Defaults to oldest-first, the
 * long-standing behaviour, so the preference is invisible until changed.
 *
 * Newest-first exists for long-running issues where the latest entry is
 * what matters and scrolling past the whole history to reach it is pure
 * cost. Rendering still goes through the same virtualized list — only the
 * presentation order of the top-level groups is reversed, so grouping,
 * coalescing, thread nesting and every id-based jump keep working
 * untouched.
 */
export type TimelineOrder = "oldest-first" | "newest-first";

interface TimelineDisplayStore {
  order: TimelineOrder;
  setOrder: (order: TimelineOrder) => void;
  toggleOrder: () => void;
}

export const useTimelineDisplayStore = create<TimelineDisplayStore>()(
  persist(
    (set) => ({
      order: "oldest-first",
      setOrder: (order) => set({ order }),
      toggleOrder: ( ) =>
        set((s) => ({
          order: s.order === "newest-first" ? "oldest-first" : "newest-first",
        })),
    }),
    {
      name: "multica_timeline_display",
      storage: createJSONStorage(() => defaultStorage),
    },
  ),
);
