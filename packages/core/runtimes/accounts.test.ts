import { describe, expect, it } from "vitest";
import {
  accountModelScope,
  accountRequestFields,
  accountSelectionValue,
  agentAccountSelection,
  parseAccountSelectionValue,
  runtimeSupportsAccounts,
  selectableAccounts,
} from "./accounts";
import type { WorkspaceAccount } from "../types/agent";

const acct = (over: Partial<WorkspaceAccount>): WorkspaceAccount => ({
  id: "a1",
  workspaceId: "w",
  provider: "freebuff-desktop",
  label: "A",
  enabled: true,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("agent account selection", () => {
  it("normalises what an agent record carries", () => {
    expect(agentAccountSelection({})).toEqual({ mode: "default", accountId: "" });
    expect(agentAccountSelection({ account_mode: "any" })).toEqual({ mode: "any", accountId: "" });
    expect(agentAccountSelection({ account_mode: "specific", account_id: "x" })).toEqual({
      mode: "specific",
      accountId: "x",
    });
    // A specific mode without an id cannot be honoured; fall back to default.
    expect(agentAccountSelection({ account_mode: "specific" })).toEqual({
      mode: "default",
      accountId: "",
    });
  });

  it("round-trips through the single select value", () => {
    for (const sel of [
      { mode: "default", accountId: "" },
      { mode: "any", accountId: "" },
      { mode: "specific", accountId: "abc" },
    ] as const) {
      expect(parseAccountSelectionValue(accountSelectionValue(sel))).toEqual(sel);
    }
  });

  it("scopes the model catalog by selection", () => {
    expect(accountModelScope({ mode: "default", accountId: "" })).toBeUndefined();
    expect(accountModelScope({ mode: "any", accountId: "" })).toBe("all");
    expect(accountModelScope({ mode: "specific", accountId: "abc" })).toBe("abc");
  });

  it("only sends an id for a specific account", () => {
    expect(accountRequestFields({ mode: "any", accountId: "stale" })).toEqual({
      account_mode: "any",
      account_id: "",
    });
    expect(accountRequestFields({ mode: "specific", accountId: "abc" })).toEqual({
      account_mode: "specific",
      account_id: "abc",
    });
  });

  it("offers only enabled freebuff-desktop accounts", () => {
    const list = [acct({ id: "1" }), acct({ id: "2", enabled: false }), acct({ id: "3", provider: "other" })];
    expect(selectableAccounts(list).map((a) => a.id)).toEqual(["1"]);
    expect(selectableAccounts(undefined)).toEqual([]);
  });

  it("recognises runtimes that can run accounts", () => {
    expect(runtimeSupportsAccounts("codebuddy")).toBe(true);
    expect(runtimeSupportsAccounts("claude")).toBe(false);
    expect(runtimeSupportsAccounts(undefined)).toBe(false);
  });
});
