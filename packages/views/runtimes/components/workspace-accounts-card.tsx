"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2, ExternalLink, Copy, Check } from "@multica/ui/icons";
import type { AgentRuntime, WorkspaceAccount } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeProfileListOptions } from "@multica/core/runtimes";
import {
  useCreateWorkspaceAccount,
  useDeleteWorkspaceAccount,
  useUpdateWorkspaceAccount,
  workspaceAccountListOptions,
} from "@multica/core/runtimes/accounts";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
import { useT } from "../../i18n";
import { openExternal } from "../../platform";
import { copyText } from "@multica/ui/lib/clipboard";

const FREEBUFF_DESKTOP_COMMAND_PREFIX = "freebuff-desktop";

const MOVING_STATES = new Set(["requested", "awaiting_login", "removing"]);

function hasEngineVersionOptions(account: WorkspaceAccount): boolean {
  return Boolean(account.runtimeId && account.daemonAccountId) &&
    (account.installedVersions?.length ?? 0) > 0;
}

export function WorkspaceAccountsCard({
  runtime,
  canManage,
}: {
  runtime: AgentRuntime;
  canManage: boolean;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const { data: profiles = [] } = useQuery(runtimeProfileListOptions(wsId));
  const profile = runtime.profile_id
    ? profiles.find((p) => p.id === runtime.profile_id)
    : undefined;
  const isFreebuffDesktop =
    profile?.command_name?.startsWith(FREEBUFF_DESKTOP_COMMAND_PREFIX) ?? false;

  const { data: workspaceAccounts = [] } = useQuery({
    ...workspaceAccountListOptions(wsId),
    enabled: isFreebuffDesktop,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a: { state?: string }) =>
        MOVING_STATES.has(a.state ?? ""),
      )
        ? 3000
        : 30000,
  });
  const accounts = workspaceAccounts.filter(
    (account) => !account.runtimeId || account.runtimeId === runtime.id,
  );
  const create = useCreateWorkspaceAccount(wsId);
  const update = useUpdateWorkspaceAccount(wsId);
  const remove = useDeleteWorkspaceAccount(wsId);

  const [label, setLabel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  if (!isFreebuffDesktop) return null;

  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : t(($) => $.accounts.toast_failed));

  const handleAddManaged = async () => {
    try {
      await create.mutateAsync({
        label: label.trim() || undefined,
        managed: true,
        runtime_id: runtime.id,
      });
      setLabel("");
    } catch (error) {
      fail(error);
    }
  };

  const handleAddManual = async () => {
    try {
      await create.mutateAsync({
        label: label.trim(),
        endpoint: endpoint.trim() || undefined,
        credential_ref: credentialRef.trim() || undefined,
      });
      setLabel("");
      setEndpoint("");
      setCredentialRef("");
    } catch (error) {
      fail(error);
    }
  };

  const handleCopy = async (id: string, url: string) => {
    if (await copyText(url)) {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    }
  };

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-2.5">
        <span className="text-caption font-semibold">{t(($) => $.accounts.title)}</span>
        <p className="mt-0.5 text-caption text-muted-foreground">
          {t(($) => $.accounts.description)}
        </p>
      </div>

      <div className="divide-y">
        {accounts.length === 0 ? (
          <p className="px-4 py-3 text-caption text-muted-foreground">
            {t(($) => $.accounts.empty)}
          </p>
        ) : (
          accounts.map((account) => (
            <div key={account.id} className="flex flex-col gap-2 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium">
                    {account.label || account.daemonAccountId || account.id}
                  </div>
                  <div className="truncate text-caption text-muted-foreground">
                    {account.endpoint || t(($) => $.accounts.no_endpoint)}
                    {account.credentialRef ? ` · ${account.credentialRef}` : ""}
                    {account.runtimeId && account.state ? ` · ${account.state}` : ""}
                  </div>
                  {account.error ? (
                    <div className="text-caption text-destructive">{account.error}</div>
                  ) : null}
                  {canManage && (account.state === "failed" || account.state === "signed_out") ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="self-start"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ accountId: account.id, patch: { retry: true } }, { onError: fail })}
                    >
                      {t(($) => $.accounts.retry)}
                    </Button>
                  ) : null}
                </div>
                {hasEngineVersionOptions(account) ? (
                  <select
                    value={account.engineVersion ?? ""}
                    disabled={!canManage || update.isPending}
                    aria-label={t(($) => $.accounts.engine_version_aria, { label: account.label })}
                    onChange={(event) =>
                      update.mutate(
                        {
                          accountId: account.id,
                          patch: { engine_version: event.target.value },
                        },
                        { onError: fail },
                      )
                    }
                    className="max-w-36 rounded-md border bg-muted px-2 py-1 text-caption"
                  >
                    <option value="">{t(($) => $.accounts.engine_default)}</option>
                    {account.installedVersions?.map((version) => (
                      <option key={version.version} value={version.version}>
                        {version.version}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Switch
                  checked={account.enabled}
                  disabled={!canManage || update.isPending}
                  aria-label={t(($) => $.accounts.enabled_aria, { label: account.label })}
                  onCheckedChange={(enabled) =>
                    update.mutate({ accountId: account.id, patch: { enabled } }, { onError: fail })
                  }
                />
                {canManage && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    aria-label={t(($) => $.accounts.delete_aria, { label: account.label })}
                    onClick={() => remove.mutate(account.id, { onError: fail })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {hasEngineVersionOptions(account) ? (
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.accounts.engine_version_note)}
                </p>
              ) : null}
              {account.state === "awaiting_login" && account.loginUrl ? (
                <div className="flex items-stretch gap-1.5">
                  <input
                    readOnly
                    value={account.loginUrl}
                    className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-1.5 text-caption"
                  />
                  <Button size="sm" variant="outline" aria-label={t(($) => $.accounts.copy_login_url_aria)} onClick={() => handleCopy(account.id, account.loginUrl!)}>
                    {copied === account.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="sm" variant="outline" aria-label={t(($) => $.accounts.open_login_url_aria)} onClick={() => openExternal(account.loginUrl!, { webTarget: "new-tab" })}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {canManage && (
        <div className="space-y-2 border-t px-4 py-3">
          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t(($) => $.accounts.label_placeholder)}
              aria-label={t(($) => $.accounts.label_placeholder)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddManaged}
              disabled={create.isPending}
            >
              {t(($) => $.accounts.add)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdvanced((v) => !v)}>
              {t(($) => $.accounts.advanced)}
            </Button>
          </div>
          {advanced && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={t(($) => $.accounts.endpoint_placeholder)}
                aria-label={t(($) => $.accounts.endpoint_placeholder)}
              />
              <Input
                value={credentialRef}
                onChange={(e) => setCredentialRef(e.target.value)}
                placeholder={t(($) => $.accounts.credential_placeholder)}
                aria-label={t(($) => $.accounts.credential_placeholder)}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddManual}
                disabled={!label.trim() || create.isPending}
              >
                {t(($) => $.accounts.add)}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
