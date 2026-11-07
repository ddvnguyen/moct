/**
 * @vitest-environment jsdom
 *
 * M-173: the dsh island owns one global project picker, so the board has to
 * translate the host's selection into the scope the surface already queries by.
 * Asserting the prop the controller receives is the cheapest honest check that
 * the filter reaches the query — the surface itself compiles a project scope
 * into `IssueTableQuerySpec.scope.kind === "project"`, which its own tests pin.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageChromeProvider } from "../../layout/page-chrome";
import { IssuesPage } from "./issues-page";

vi.mock("../../i18n", () => ({
  useT: () => ({ t: (selector: (dictionary: unknown) => string) => selector({}) }),
}));

vi.mock("@multica/core/issues/stores/issues-scope-store", () => ({
  useIssuesScope: () => "all",
}));

// The surface is the boundary under test's edge: record what the page handed
// it instead of rendering a board that needs a query client, an API and a
// virtualizer to say the same thing.
// The page's header is upstream's IssueViewHeader, which owns its own query
// client and view bar; this test is about the scope handed to the surface.
vi.mock("../../issue-views/view-header", () => ({
  IssueViewHeader: () => null,
}));

// Chat creation reads the workspace through react-query; the empty-state action
// it powers is not what this test is about.
vi.mock("../../chat/use-start-chat-with-draft", () => ({
  useStartChatWithDraft: () => null,
}));

vi.mock("../surface/issue-surface", () => ({
  IssueSurface: ({
    scope,
    createDefaults,
  }: {
    scope: unknown;
    createDefaults?: unknown;
  }) => (
    <div
      data-testid="surface"
      data-scope={JSON.stringify(scope)}
      data-create-defaults={JSON.stringify(createDefaults ?? null)}
    />
  ),
}));

describe("IssuesPage host project scope", () => {
  it("keeps the workspace scope when the host selects All projects", () => {
    render(
      <PageChromeProvider projectId={null}>
        <IssuesPage />
      </PageChromeProvider>,
    );

    const surface = screen.getByTestId("surface");
    expect(JSON.parse(surface.dataset.scope ?? "null")).toEqual({
      type: "workspace",
      actorKind: "all",
    });
    expect(JSON.parse(surface.dataset.createDefaults ?? "null")).toBeNull();
    cleanup();
  });

  it("narrows the board to the selected project and defaults new issues into it", () => {
    render(
      <PageChromeProvider projectId="p1">
        <IssuesPage />
      </PageChromeProvider>,
    );

    const surface = screen.getByTestId("surface");
    expect(JSON.parse(surface.dataset.scope ?? "null")).toEqual({
      type: "project",
      projectId: "p1",
      actorKind: "all",
    });
    expect(JSON.parse(surface.dataset.createDefaults ?? "null")).toEqual({
      project_id: "p1",
    });
    cleanup();
  });
});
