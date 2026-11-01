// @vitest-environment jsdom
import { useIssueOpeningStore } from "@multica/core/issues/stores/issue-opening-store";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { Issue } from "@multica/core/types";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { IssueOpeningCapabilityProvider } from "../surface/issue-opening-capability";
import {
  IssuePeekActionsContext,
  IssuePeekIdContext,
  type IssuePeekActions,
} from "../surface/peek-context";
import { DraggableBoardCard } from "./board-card";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/properties", () => ({
  propertyListOptions: () => ({ queryKey: ["properties"] }),
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/acme/issues/${id}` }),
}));

vi.mock("@multica/core/issues/stores/view-store-context", () => ({
  useViewStore: (selector: (state: unknown) => unknown) =>
    selector({
      viewMode: "board",
      grouping: "status",
      swimlaneGrouping: "assignee",
      cardProperties: {},
      cardPropertyIds: [],
    }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
}));

vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: () => ({ t: () => "Translated" }),
  useTimeAgo: () => () => "now",
}));

vi.mock("../actions", () => ({
  IssueActionsContextMenu: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./issue-agent-activity-indicator", () => ({
  IssueAgentActivityIndicator: () => null,
}));

vi.mock("./custom-status-chip", () => ({
  CustomStatusChip: () => null,
  useIsCustomStatus: () => false,
}));

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path) => `https://app.example${path}`,
};

const peek: IssuePeekActions = {
  open: vi.fn(),
  toggle: vi.fn(),
  close: vi.fn(),
  publishColumns: vi.fn(),
};

const issue = {
  id: "issue-1",
  identifier: "MUL-1",
  title: "Peekable card",
  description: null,
  status: "todo",
  priority: "none",
  assignee_type: null,
  assignee_id: null,
  labels: [],
  properties: {},
  start_date: null,
  due_date: null,
  updated_at: "2026-09-27T00:00:00Z",
} as unknown as Issue;

function renderCard({ withPeek = true, peekedId = null as string | null, supportsTabs = false } = {}) {
  const card = (
    <DndContext>
      <SortableContext items={[issue.id]}>
        <DraggableBoardCard issue={issue} />
      </SortableContext>
    </DndContext>
  );
  return render(
    <NavigationProvider value={navigation}>
      <IssueOpeningCapabilityProvider supportsTabs={supportsTabs} supportsPeek={!supportsTabs}>
      {withPeek ? (
        <IssuePeekActionsContext.Provider value={peek}>
          <IssuePeekIdContext.Provider value={peekedId}>{card}</IssuePeekIdContext.Provider>
        </IssuePeekActionsContext.Provider>
      ) : (
        card
      )}
      </IssueOpeningCapabilityProvider>
    </NavigationProvider>,
  );
}

const link = () => screen.getByRole("link");
const cardRoot = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-peek-target="issue-1"]')!;

afterEach(cleanup);

describe("DraggableBoardCard side peek", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete navigation.openInNewTab;
    useIssueOpeningStore.persist.clearStorage();
    useIssueOpeningStore.setState({ openMode: "page", hasUserChoice: false });
  });

  it("opens the peek on Shift+Click instead of navigating", () => {
    renderCard();
    expect(fireEvent.click(link(), { shiftKey: true })).toBe(false);
    expect(peek.toggle).toHaveBeenCalledWith("issue-1");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("still navigates on a plain click", () => {
    renderCard();
    fireEvent.click(link());
    expect(navigation.push).toHaveBeenCalledWith("/acme/issues/issue-1");
    expect(peek.toggle).not.toHaveBeenCalled();
  });

  it("opens a header tab on a plain click when the host offers tabs", () => {
    navigation.openInNewTab = vi.fn();
    renderCard({ supportsTabs: true });
    expect(fireEvent.click(link())).toBe(false);
    expect(navigation.openInNewTab).toHaveBeenCalledWith(
      "/acme/issues/MUL-1",
      "MUL-1",
      { activate: true },
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("opens the canonical issue route in a background tab on middle click", () => {
    navigation.openInNewTab = vi.fn();
    renderCard({ supportsTabs: true });
    fireEvent(link(), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(navigation.openInNewTab).toHaveBeenCalledWith(
      "/acme/issues/MUL-1",
      "MUL-1",
      { activate: false },
    );
  });

  it("migrates a saved side peek choice to tabs when the host cannot show a peek", () => {
    useIssueOpeningStore.setState({ openMode: "peek", hasUserChoice: true });
    renderCard({ supportsTabs: true });
    expect(useIssueOpeningStore.getState().openMode).toBe("tab");
  });

  it("leaves Cmd/Ctrl+Shift+Click to the new-tab behavior", () => {
    renderCard();
    fireEvent.click(link(), { shiftKey: true, metaKey: true });
    fireEvent.click(link(), { shiftKey: true, ctrlKey: true });
    expect(peek.toggle).not.toHaveBeenCalled();
  });

  it("peeks the focused card on Space", () => {
    const { container } = renderCard();
    expect(fireEvent.keyDown(cardRoot(container), { key: " " })).toBe(false);
    fireEvent.keyDown(link(), { key: " " });
    expect(peek.toggle).toHaveBeenCalledTimes(2);
  });

  it("reacts immediately to the preference and keeps repeated plain clicks open", () => {
    renderCard();
    act(() => useIssueOpeningStore.getState().setOpenMode("peek"));
    fireEvent.click(link());
    fireEvent.click(link());
    expect(peek.open).toHaveBeenCalledTimes(2);
    expect(peek.open).toHaveBeenCalledWith("issue-1");
    expect(peek.toggle).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    act(() => useIssueOpeningStore.getState().setOpenMode("page"));
    fireEvent.click(link());
    expect(navigation.push).toHaveBeenCalledWith("/acme/issues/issue-1");
  });

  it("opens the full page in place on Shift+Click when the preference is peek", () => {
    useIssueOpeningStore.getState().setOpenMode("peek");
    renderCard();
    // Handled here, not left to the browser (a new window on web).
    expect(fireEvent.click(link(), { shiftKey: true })).toBe(false);
    expect(navigation.push).toHaveBeenCalledWith("/acme/issues/issue-1");
    expect(peek.open).not.toHaveBeenCalled();
    expect(peek.toggle).not.toHaveBeenCalled();
  });

  it("still navigates without a peek host when the preference is peek", () => {
    useIssueOpeningStore.getState().setOpenMode("peek");
    renderCard({ withPeek: false });
    fireEvent.click(link());
    expect(navigation.push).toHaveBeenCalledWith("/acme/issues/issue-1");
    expect(peek.open).not.toHaveBeenCalled();
  });

  it("marks the peeked card", () => {
    const { container } = renderCard({ peekedId: "issue-1" });
    expect(cardRoot(container).hasAttribute("data-peeked")).toBe(true);
  });

  it("keeps the browser's shift-click outside a peek host", () => {
    renderCard({ withPeek: false });
    // No handler claims the gesture: AppLink leaves it to the browser.
    fireEvent.click(link(), { shiftKey: true });
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
