"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useIssueOpeningStore, type IssueOpenMode } from "@multica/core/issues/stores/issue-opening-store";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../../navigation";

interface IssueOpeningCapability {
  supportsTabs: boolean;
  supportsPeek: boolean;
  openMode: IssueOpenMode;
  openIssueInTab: (issueId: string, activate?: boolean) => boolean;
}

const DEFAULT_CAPABILITY: IssueOpeningCapability = {
  supportsTabs: false,
  supportsPeek: true,
  openMode: "page",
  openIssueInTab: () => false,
};

const IssueOpeningCapabilityContext = createContext(DEFAULT_CAPABILITY);

/** Platform-owned issue opening behavior. Web and desktop keep the upstream modes. */
export function IssueOpeningCapabilityProvider({
  children,
  supportsTabs = false,
  supportsPeek = true,
}: {
  children: ReactNode;
  supportsTabs?: boolean;
  supportsPeek?: boolean;
}) {
  const mode = useIssueOpeningStore((state) => state.openMode);
  const hasUserChoice = useIssueOpeningStore((state) => state.hasUserChoice);
  const setOpenMode = useIssueOpeningStore((state) => state.setOpenMode);
  const setDefaultOpenMode = useIssueOpeningStore((state) => state.setDefaultOpenMode);
  const navigation = useNavigation();
  const paths = useWorkspacePaths();

  useEffect(() => {
    if (!supportsTabs) return;
    if (mode === "peek") setOpenMode("tab");
    else if (!hasUserChoice) setDefaultOpenMode("tab");
  }, [supportsTabs, mode, hasUserChoice, setOpenMode, setDefaultOpenMode]);

  const openIssueInTab = useCallback((issueId: string, activate = true) => {
    if (!supportsTabs || !navigation.openInNewTab) return false;
    navigation.openInNewTab(paths.issueDetail(issueId), issueId, { activate });
    return true;
  }, [supportsTabs, navigation, paths]);

  const value = useMemo<IssueOpeningCapability>(() => ({
    supportsTabs,
    supportsPeek,
    openMode: supportsTabs
      ? (!hasUserChoice || mode === "peek" ? "tab" : mode)
      : mode === "tab"
        ? "page"
        : mode,
    openIssueInTab,
  }), [supportsTabs, supportsPeek, hasUserChoice, mode, openIssueInTab]);

  return (
    <IssueOpeningCapabilityContext.Provider value={value}>
      {children}
    </IssueOpeningCapabilityContext.Provider>
  );
}

export function useIssueOpeningCapability() {
  return useContext(IssueOpeningCapabilityContext);
}
