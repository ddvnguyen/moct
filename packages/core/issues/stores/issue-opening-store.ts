import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../../platform/storage";

export type IssueOpenMode = "page" | "peek" | "tab";

interface IssueOpeningState {
  openMode: IssueOpenMode;
  hasUserChoice: boolean;
  setOpenMode: (openMode: IssueOpenMode) => void;
  setDefaultOpenMode: (openMode: IssueOpenMode) => void;
}

// Like theme and comment-composer preferences, this personal navigation habit
// is saved on this device across workspaces. Existing users keep full pages.
export const useIssueOpeningStore = create<IssueOpeningState>()(
  persist(
    (set) => ({
      openMode: "page",
      hasUserChoice: false,
      setOpenMode: (openMode) => set({ openMode, hasUserChoice: true }),
      setDefaultOpenMode: (openMode) => set({ openMode }),
    }),
    {
      name: "multica_issue_opening",
      storage: createJSONStorage(() => defaultStorage),
      partialize: ({ openMode }) => ({ openMode }),
      merge: (persisted, current) => ({
        ...current,
        openMode: persisted && typeof persisted === "object" &&
          "openMode" in persisted &&
          (persisted.openMode === "peek" || persisted.openMode === "tab")
          ? persisted.openMode
          : "page",
        hasUserChoice: Boolean(persisted && typeof persisted === "object" &&
          "openMode" in persisted &&
          (persisted.openMode === "page" || persisted.openMode === "peek" || persisted.openMode === "tab")),
      }),
    },
  ),
);
