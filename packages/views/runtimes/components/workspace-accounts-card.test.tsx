// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRuntime, RuntimeProfile, WorkspaceAccount } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { WorkspaceAccountsCard } from "./workspace-accounts-card";

const api = vi.hoisted(() => ({
  listWorkspaceAccounts: vi.fn(),
  createWorkspaceAccount: vi.fn(),
  updateWorkspaceAccount: vi.fn(),
  deleteWorkspaceAccount: vi.fn(),
}));
const profileCommand = vi.hoisted(() => ({ name: "freebuff-desktop-bridge" }));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api, ApiError: class ApiError extends Error {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@multica/core/runtimes", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/runtimes")>(
    "@multica/core/runtimes",
  );
  return {
    ...actual,
    runtimeProfileListOptions: () => ({
      queryKey: ["runtime-profiles", "ws-1", "list"],
      queryFn: async () =>
        [{ id: "profile-1", command_name: profileCommand.name }] as RuntimeProfile[],
    }),
  };
});

const runtime = { id: "rt-1", provider: "codebuddy", profile_id: "profile-1" } as AgentRuntime;

const account = (over: Partial<WorkspaceAccount> = {}): WorkspaceAccount => ({
  id: "acc-1",
  workspaceId: "ws-1",
  provider: "freebuff-desktop",
  label: "Team A",
  endpoint: "http://a.test:4320",
  enabled: true,
  credentialRef: "ref-a",
  createdAt: "",
  updatedAt: "",
  ...over,
});

function renderCard(canManage: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <WorkspaceAccountsCard runtime={runtime} canManage={canManage} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profileCommand.name = "freebuff-desktop-bridge";
  api.listWorkspaceAccounts.mockResolvedValue([account()]);
  api.createWorkspaceAccount.mockResolvedValue(account({ id: "acc-2", label: "Team B" }));
  api.updateWorkspaceAccount.mockResolvedValue(account({ enabled: false }));
  api.deleteWorkspaceAccount.mockResolvedValue(undefined);
});

describe("WorkspaceAccountsCard", () => {
  it("renders nothing for a runtime that is not freebuff-desktop", async () => {
    profileCommand.name = "codebuddy-freebuff";
    renderCard(true);
    await waitFor(() => expect(api.listWorkspaceAccounts).not.toHaveBeenCalled());
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  it("lists the accounts, read-only for non-admins", async () => {
    renderCard(false);
    expect(await screen.findByText("Team A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Team A" })).toBeNull();
  });

  it("shows only accounts owned by the selected runtime", async () => {
    api.listWorkspaceAccounts.mockResolvedValue([
      account(),
      account({ id: "acc-other", label: "Other runtime", runtimeId: "rt-2" }),
    ]);
    renderCard(false);
    expect(await screen.findByText("Team A")).toBeTruthy();
    expect(screen.queryByText("Other runtime")).toBeNull();
  });

  it("lets an admin choose an installed engine version or the default", async () => {
    const user = userEvent.setup();
    api.listWorkspaceAccounts.mockResolvedValue([
      account({
        runtimeId: "rt-1",
        daemonAccountId: "daemon-1",
        engineVersion: "1.0.0",
        installedVersions: [{ version: "1.0.0" }, { version: "2.0.0", commit: "abcdef123456" }],
      }),
    ]);
    renderCard(true);

    const select = await screen.findByRole("combobox", { name: "Engine version for Team A" });
    expect(select).toHaveDisplayValue("1.0.0");
    expect(screen.getByRole("option", { name: "Default" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "2.0.0" })).toBeTruthy();
    expect(screen.getByText(/Applies after this account's running tasks finish/)).toBeTruthy();

    await user.selectOptions(select, "2.0.0");
    await waitFor(() =>
      expect(api.updateWorkspaceAccount).toHaveBeenCalledWith("ws-1", "acc-1", {
        engine_version: "2.0.0",
      }),
    );

    await user.selectOptions(select, "");
    await waitFor(() =>
      expect(api.updateWorkspaceAccount).toHaveBeenCalledWith("ws-1", "acc-1", {
        engine_version: "",
      }),
    );
  });

  it("hides engine selection for unmanaged accounts and when no versions are reported", async () => {
    api.listWorkspaceAccounts.mockResolvedValue([
      account(),
      account({
        id: "acc-2",
        label: "No versions",
        runtimeId: "rt-1",
        daemonAccountId: "daemon-2",
      }),
    ]);
    renderCard(true);
    await screen.findByText("No versions");
    expect(screen.queryByRole("combobox", { name: /Engine version/ })).toBeNull();
  });

  it("lets an admin add an account (manual, advanced)", async () => {
    const user = userEvent.setup();
    renderCard(true);
    await screen.findByText("Team A");
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(screen.getByLabelText("Label"), "Team B");
    await user.type(screen.getByLabelText("Credential reference"), "ref-b");
    const buttons = screen.getAllByRole("button", { name: "Add account" });
    await user.click(buttons.at(-1)!);
    await waitFor(() =>
      expect(api.createWorkspaceAccount).toHaveBeenCalledWith("ws-1", {
        label: "Team B",
        endpoint: undefined,
        credential_ref: "ref-b",
      }),
    );
  });

  it("lets an admin add a managed account", async () => {
    const user = userEvent.setup();
    renderCard(true);
    await screen.findByText("Team A");
    await user.type(screen.getByLabelText("Label"), "Team B");
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0]!);
    await waitFor(() =>
      expect(api.createWorkspaceAccount).toHaveBeenCalledWith("ws-1", {
        label: "Team B",
        managed: true,
        runtime_id: "rt-1",
      }),
    );
  });

  it("lets an admin delete an account", async () => {
    const user = userEvent.setup();
    renderCard(true);
    await user.click(await screen.findByRole("button", { name: "Delete Team A" }));
    await waitFor(() => expect(api.deleteWorkspaceAccount).toHaveBeenCalledWith("ws-1", "acc-1"));
  });

  it("lets an admin retry a failed sign-in", async () => {
    const user = userEvent.setup();
    api.listWorkspaceAccounts.mockResolvedValue([account({ state: "failed", error: "expired" })]);
    renderCard(true);
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(api.updateWorkspaceAccount).toHaveBeenCalledWith("ws-1", "acc-1", { retry: true }),
    );
  });

  it("shows the browser login URL while sign-in is waiting", async () => {
    api.listWorkspaceAccounts.mockResolvedValue([
      account({ runtimeId: "rt-1", state: "awaiting_login", loginUrl: "https://freebuff.example/login" }),
    ]);
    renderCard(true);
    expect(await screen.findByDisplayValue("https://freebuff.example/login")).toBeTruthy();
    expect(screen.getByText(/awaiting_login/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy sign-in link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open sign-in link" })).toBeTruthy();
  });
});
