// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceAccount } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";

const listWorkspaceAccounts = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (orig) => ({
  ...(await orig<typeof import("@multica/core/api")>()),
  api: { listWorkspaceAccounts },
}));

import { AgentAccountField } from "./agent-account-field";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

const account = (over: Partial<WorkspaceAccount>): WorkspaceAccount => ({
  id: "acc-1",
  workspaceId: "ws-1",
  provider: "freebuff-desktop",
  label: "Team A",
  enabled: true,
  createdAt: "",
  updatedAt: "",
  ...over,
});

function renderField(props: Partial<React.ComponentProps<typeof AgentAccountField>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <AgentAccountField
          runtimeProvider="codebuddy"
          value={{ mode: "default", accountId: "" }}
          onChange={vi.fn()}
          {...props}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  listWorkspaceAccounts.mockReset();
});

describe("AgentAccountField", () => {
  it("is absent on runtimes that cannot run accounts, without fetching", () => {
    renderField({ runtimeProvider: "claude" });
    expect(screen.queryByText("Account")).toBeNull();
    expect(listWorkspaceAccounts).not.toHaveBeenCalled();
  });

  it("is absent while the workspace has no account to offer", async () => {
    listWorkspaceAccounts.mockResolvedValue([]);
    renderField();
    await vi.waitFor(() => expect(listWorkspaceAccounts).toHaveBeenCalled());
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("appears once an account exists and shows the runtime default", async () => {
    listWorkspaceAccounts.mockResolvedValue([account({})]);
    renderField();
    expect(await screen.findByText("Account")).toBeTruthy();
    expect(screen.getByText("Runtime default")).toBeTruthy();
  });

  it("names the bound account even after it was disabled", async () => {
    listWorkspaceAccounts.mockResolvedValue([account({ enabled: false })]);
    renderField({ value: { mode: "specific", accountId: "acc-1" } });
    expect(await screen.findByText("Team A")).toBeTruthy();
  });

  it("shows any-account mode", async () => {
    listWorkspaceAccounts.mockResolvedValue([account({})]);
    renderField({ value: { mode: "any", accountId: "" } });
    expect(await screen.findByText("Any account")).toBeTruthy();
  });
});
