"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Plus, Timer, Wallet } from "@multica/ui/icons";
import type { AgentRuntime, FreebuffAccount, FreebuffVersion } from "@multica/core/types";
// Deep import on purpose: the freebuff helpers live behind their own
// entry point so a test that stubs the runtimes barrel does not have to
// know about them.
import {
  freebuffAccountsOptions,
  useAddFreebuffAccount,
  useRemoveFreebuffAccount,
  useRetryFreebuffAccountLogin,
  useSetFreebuffDefaultAccount,
  useSetFreebuffEngineVersion,
} from "@multica/core/runtimes/freebuff";
import { Button } from "@multica/ui/components/ui/button";
import { copyText } from "@multica/ui/lib/clipboard";
import { useT } from "../../i18n";
import { openExternal } from "../../platform";

// Freebuff accounts card.
//
// A Freebuff runtime holds any number of accounts; tasks run on the default
// one. Adding an account asks the daemon for a sign-in link — the account
// host's own page, so it can be copied and opened in any browser — and the
// card follows the sign-in until the daemon reports the account as connected.
// A connected account shows what it is worth right now: the open session
// slot, the credit left, and the price of each model.
//
// The card renders nothing for a runtime that is not a Freebuff runtime.

const FREEBUFF_PROVIDER = "freebuff";

// A tick so the countdown in the session row moves on its own.
const TICK_MS = 15_000;

function formatRemaining(remainingMs: number | null | undefined): string | null {
  if (remainingMs == null) return null;
  const totalMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// The price of a model is Freebucks per hour of session. The account host
// has been seen to report it as a number and as an object, so anything that
// is not a plain number is rendered as JSON rather than dropped.
function formatPrice(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["credits", "price", "perHour", "value", "amount"]) {
      const nested = record[key];
      if (typeof nested === "number" || typeof nested === "string") {
        return String(nested);
      }
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function formatClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function FreebuffAccountCard({ runtime }: { runtime: AgentRuntime }) {
  const { t } = useT("runtimes");
  const [, setTick] = useState(0);
  const isFreebuff = runtime.provider === FREEBUFF_PROVIDER;

  const { data } = useQuery({
    ...freebuffAccountsOptions(runtime.id),
    enabled: isFreebuff,
  });
  const addAccount = useAddFreebuffAccount();

  useEffect(() => {
    if (!isFreebuff) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [isFreebuff]);

  const setEngine = useSetFreebuffEngineVersion();

  if (!isFreebuff) return null;

  const accounts = data?.accounts ?? [];
  const defaultId = data?.default_account_id ?? null;
  const versions = data?.installed_versions ?? [];
  const engineVersion = data?.engine_version ?? "";

  const handleAdd = async () => {
    try {
      await addAccount.mutateAsync(runtime.id);
    } catch (error) {
      toast.error(errorMessage(error, t(($) => $.freebuff.toast_add_failed)));
    }
  };

  const handleEngine = async (version: string) => {
    try {
      await setEngine.mutateAsync({ runtimeId: runtime.id, version });
    } catch (error) {
      toast.error(errorMessage(error, t(($) => $.freebuff.engine_select_failed)));
    }
  };

  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-caption font-semibold">
          {t(($) => $.freebuff.title)}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={addAccount.isPending}
        >
          <Plus className="h-3.5 w-3.5" />
          {t(($) => $.freebuff.add_account)}
        </Button>
      </div>

      <FreebuffEngineRow
        versions={versions}
        pinned={engineVersion}
        pending={setEngine.isPending}
        onChange={handleEngine}
      />

      {accounts.length === 0 ? (
        <p className="px-4 py-3 text-caption text-muted-foreground">
          {t(($) => $.freebuff.empty)}
        </p>
      ) : (
        <ul className="divide-y">
          {accounts.map((account) => (
            <FreebuffAccountRow
              key={account.id}
              runtimeId={runtime.id}
              account={account}
              isDefault={account.id === defaultId}
              onlyAccount={accounts.length === 1}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// The engine version the runtime's tasks run on. The list is what the daemon
// last reported installing; choosing one pins it, choosing the default
// unpins. A change applies on the next run, not one in flight.
function FreebuffEngineRow({
  versions,
  pinned,
  pending,
  onChange,
}: {
  versions: FreebuffVersion[];
  pinned: string;
  pending: boolean;
  onChange: (version: string) => void | Promise<void>;
}) {
  const { t } = useT("runtimes");
  if (versions.length === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
      <span className="text-caption font-medium">
        {t(($) => $.freebuff.engine_title)}
      </span>
      <div className="flex items-center gap-2">
        {pinned ? (
          <span className="text-caption text-muted-foreground">
            {t(($) => $.freebuff.engine_pinned_note)}
          </span>
        ) : null}
        <select
          value={pinned}
          disabled={pending}
          aria-label={t(($) => $.freebuff.engine_title)}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border bg-muted px-2 py-1 text-caption"
        >
          <option value="">{t(($) => $.freebuff.engine_default)}</option>
          {versions.map((v) => (
            <option key={v.version} value={v.version}>
              {v.commit ? `${v.version} (${v.commit.slice(0, 7)})` : v.version}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function FreebuffAccountRow({
  runtimeId,
  account,
  isDefault,
  onlyAccount,
}: {
  runtimeId: string;
  account: FreebuffAccount;
  isDefault: boolean;
  onlyAccount: boolean;
}) {
  const { t } = useT("runtimes");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const removeAccount = useRemoveFreebuffAccount();
  const retryLogin = useRetryFreebuffAccountLogin();
  const setDefault = useSetFreebuffDefaultAccount();

  const expiry = useMemo(() => formatClock(account.expires_at), [account.expires_at]);
  const loginUrl = account.login_url ?? null;
  const state = account.state;
  const name = account.label || t(($) => $.freebuff.new_account);

  const run = async (action: () => Promise<unknown>, failed: string) => {
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error, failed));
    }
  };

  const handleCopy = async () => {
    if (!loginUrl) return;
    if (await copyText(loginUrl)) {
      setCopied(true);
      toast.success(t(($) => $.freebuff.link_copied));
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(t(($) => $.freebuff.link_copy_failed));
    }
  };

  const stateLabel = (() => {
    switch (state) {
      case "connected":
        return null;
      case "requested":
        return t(($) => $.freebuff.state_requested);
      case "awaiting_login":
        return t(($) => $.freebuff.state_awaiting_login);
      case "signed_out":
        return t(($) => $.freebuff.state_signed_out);
      case "failed":
        return t(($) => $.freebuff.state_failed);
      case "removing":
        return t(($) => $.freebuff.state_removing);
      default:
        return t(($) => $.freebuff.state_unknown);
    }
  })();

  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-caption font-medium">{name}</span>
            {isDefault ? (
              <span className="rounded-xs bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
                {t(($) => $.freebuff.default_badge)}
              </span>
            ) : null}
          </div>
          {stateLabel ? (
            <div className="text-caption text-muted-foreground">{stateLabel}</div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {state === "connected" && !isDefault && !onlyAccount ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={setDefault.isPending}
              onClick={() =>
                run(
                  () => setDefault.mutateAsync({ runtimeId, accountId: account.id }),
                  t(($) => $.freebuff.toast_action_failed),
                )
              }
            >
              {t(($) => $.freebuff.make_default)}
            </Button>
          ) : null}
          {state === "signed_out" || state === "failed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={retryLogin.isPending}
              onClick={() =>
                run(
                  () => retryLogin.mutateAsync({ runtimeId, accountId: account.id }),
                  t(($) => $.freebuff.toast_action_failed),
                )
              }
            >
              {t(($) => $.freebuff.sign_in_again)}
            </Button>
          ) : null}
          {state === "removing" ? null : confirmingRemove ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={removeAccount.isPending}
                onClick={() =>
                  run(
                    () => removeAccount.mutateAsync({ runtimeId, accountId: account.id }),
                    t(($) => $.freebuff.toast_action_failed),
                  )
                }
              >
                {t(($) => $.freebuff.confirm_remove)}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                {t(($) => $.freebuff.cancel)}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(true)}>
              {t(($) => $.freebuff.remove)}
            </Button>
          )}
        </div>
      </div>

      {state === "awaiting_login" && loginUrl ? (
        <div className="space-y-2">
          <p className="text-caption text-muted-foreground">
            {t(($) => $.freebuff.open_link_hint)}
            {expiry ? ` · ${t(($) => $.freebuff.link_expires, { time: expiry })}` : ""}
          </p>
          <div className="flex items-stretch gap-1.5">
            <input
              readOnly
              value={loginUrl}
              aria-label={t(($) => $.freebuff.link_label)}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-1.5 text-caption"
            />
            <Button size="sm" variant="outline" onClick={handleCopy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {t(($) => $.freebuff.copy_link)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openExternal(loginUrl, { webTarget: "new-tab" })}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t(($) => $.freebuff.open_link)}
            </Button>
          </div>
        </div>
      ) : null}

      {state === "failed" && account.error ? (
        <p className="text-caption text-destructive">{account.error}</p>
      ) : null}

      {state === "connected" ? <FreebuffStatusDetails account={account} /> : null}
    </li>
  );
}

// What a connected account is worth right now. Every part is optional: the
// daemon reports whatever the account host told it.
function FreebuffStatusDetails({ account }: { account: FreebuffAccount }) {
  const { t } = useT("runtimes");
  const status = account.status ?? null;
  const credit = status?.credit ?? null;
  const prices = status?.prices ?? null;
  const sessionState = status?.status ?? null;
  const remaining = formatRemaining(status?.remainingMs);
  const hasDetails = Boolean(sessionState || credit || (prices && Object.keys(prices).length > 0));

  if (!hasDetails) {
    return status?.message ? (
      <p className="text-caption text-muted-foreground">{status.message}</p>
    ) : null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <Timer className="mt-0.5 h-4 w-4 shrink-0 text-faint-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-caption font-medium">{t(($) => $.freebuff.session_title)}</div>
          <div className="mt-0.5 text-caption text-muted-foreground">
            {sessionState
              ? `${t(($) => $.freebuff.session_state, { state: sessionState })}${
                  remaining ? ` · ${t(($) => $.freebuff.session_remaining, { time: remaining })}` : ""
                }`
              : t(($) => $.freebuff.session_none)}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-faint-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-caption font-medium">{t(($) => $.freebuff.credit_title)}</div>
          <div className="mt-0.5 text-caption text-muted-foreground">
            {t(($) => $.freebuff.credit_daily, {
              remaining: credit?.dailyRemaining ?? 0,
              limit: credit?.dailyLimit ?? 0,
            })}
          </div>
          {credit?.balance != null ? (
            <div className="text-caption text-muted-foreground">
              {t(($) => $.freebuff.credit_total, { total: credit.balance })}
            </div>
          ) : null}
        </div>
      </div>

      {prices && Object.keys(prices).length > 0 ? (
        <div className="text-caption">
          <div className="font-medium">{t(($) => $.freebuff.prices_title)}</div>
          <div className="mt-1 space-y-0.5">
            {Object.entries(prices).map(([model, price]) => (
              <div key={model} className="flex justify-between gap-3 text-muted-foreground">
                <span className="truncate">{model}</span>
                <span className="shrink-0 tabular-nums">{formatPrice(price) ?? "—"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
