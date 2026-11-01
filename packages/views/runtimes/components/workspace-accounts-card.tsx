"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "@multica/ui/icons";
import type { AgentRuntime } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeProfileListOptions } from "@multica/core/runtimes";
// Deep import on purpose, like the freebuff helpers: tests that stub the
// runtimes barrel (the runtime detail page) must not have to know about it.
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

// Workspace accounts card (M-153).
//
// A freebuff-desktop runtime can run agents against any of the workspace's
// accounts. Everyone in the workspace can see them; owners and admins add,
// disable and remove them. An account is a label, the endpoint of the
// Freebuff Desktop server it talks to, and an optional credential reference —
// a name the daemon resolves on its own machine. A secret is never entered or
// stored here.
//
// The card renders nothing for a runtime that is not a freebuff-desktop one.

const FREEBUFF_DESKTOP_COMMAND_PREFIX = "freebuff-desktop";

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

  const { data: accounts = [] } = useQuery({
    ...workspaceAccountListOptions(wsId),
    enabled: isFreebuffDesktop,
  });
  const create = useCreateWorkspaceAccount(wsId);
  const update = useUpdateWorkspaceAccount(wsId);
  const remove = useDeleteWorkspaceAccount(wsId);

  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");

  if (!isFreebuffDesktop) return null;

  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : t(($) => $.accounts.toast_failed));

  const handleAdd = async () => {
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
            <div key={account.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium">{account.label}</div>
                <div className="truncate text-caption text-muted-foreground">
                  {account.endpoint || t(($) => $.accounts.no_endpoint)}
                  {account.credential_ref ? ` · ${account.credential_ref}` : ""}
                </div>
              </div>
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
          ))
        )}
      </div>

      {canManage && (
        <div className="space-y-2 border-t px-4 py-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t(($) => $.accounts.label_placeholder)}
              aria-label={t(($) => $.accounts.label_placeholder)}
            />
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
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={!label.trim() || create.isPending}
          >
            {t(($) => $.accounts.add)}
          </Button>
        </div>
      )}
    </div>
  );
}
