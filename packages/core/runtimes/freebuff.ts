import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { FreebuffAccount, FreebuffAccounts } from "../types/agent";

// Freebuff accounts of a runtime.
//
// The accounts live on the daemon's machine, so what the UI shows is always a
// snapshot the daemon pushed. While a sign-in is in flight the snapshot
// changes on its own — the daemon reports the link, then the outcome — so the
// query polls quickly until nothing is moving and slowly afterwards.

export const freebuffKeys = {
  accounts: (runtimeId: string) => ["runtimes", "freebuff", runtimeId] as const,
};

// The account states that mean "something is still moving".
const MOVING_STATES = new Set(["requested", "awaiting_login", "removing"]);

export function freebuffAccountsOptions(runtimeId: string) {
  return queryOptions({
    queryKey: freebuffKeys.accounts(runtimeId),
    queryFn: () => api.getFreebuffAccounts(runtimeId),
    // Fast while a sign-in or a removal is in flight (the link and the
    // outcome arrive as separate pushes), slow otherwise.
    refetchInterval: (query) =>
      query.state.data?.accounts.some((a) => MOVING_STATES.has(a.state)) ? 3000 : 30000,
    staleTime: 0,
  });
}

function useInvalidateAccounts() {
  const qc = useQueryClient();
  return (runtimeId: string) =>
    qc.invalidateQueries({ queryKey: freebuffKeys.accounts(runtimeId) });
}

export function useAddFreebuffAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (runtimeId: string) => api.addFreebuffAccount(runtimeId),
    onSettled: (_data, _error, runtimeId) => invalidate(runtimeId),
  });
}

export function useRemoveFreebuffAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (v: { runtimeId: string; accountId: string }) =>
      api.removeFreebuffAccount(v.runtimeId, v.accountId),
    onSettled: (_data, _error, v) => invalidate(v.runtimeId),
  });
}

export function useRetryFreebuffAccountLogin() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (v: { runtimeId: string; accountId: string }) =>
      api.retryFreebuffAccountLogin(v.runtimeId, v.accountId),
    onSettled: (_data, _error, v) => invalidate(v.runtimeId),
  });
}

export function useSetFreebuffDefaultAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (v: { runtimeId: string; accountId: string }) =>
      api.setFreebuffDefaultAccount(v.runtimeId, v.accountId),
    onSettled: (_data, _error, v) => invalidate(v.runtimeId),
  });
}

export function useSetFreebuffEngineVersion() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (v: { runtimeId: string; version: string }) =>
      api.setFreebuffEngineVersion(v.runtimeId, v.version),
    onSettled: (_data, _error, v) => invalidate(v.runtimeId),
  });
}

export type { FreebuffAccount, FreebuffAccounts };
