"use client";

import { useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Check, Copy } from "@multica/ui/icons";

import { mmxBuild } from "../../build-info";
import { useT } from "../../i18n";
import { currentPath, useNavigation } from "../../navigation";
import { SettingsRow } from "./settings-layout";

/**
 * "MMX version" — Multica Settings' build-identity row (M-155).
 *
 * The row shows the stamp; the copy button hands over everything an agent
 * needs to reproduce the report: `version · sha · route` (the route is the
 * in-app path the reader is on, so "settings" vs "board" is never in doubt).
 *
 * Rendered only when the host injected a build: the island's bundle always
 * does, web and desktop builds do not, and an unstamped host must not invent
 * a version string.
 */
export function MmxVersionRow() {
  const { t } = useT("settings");
  const navigation = useNavigation();
  const [copied, setCopied] = useState(false);
  const build = mmxBuild();
  if (build === null) return null;

  const copyValue = `${build.stamp} · ${build.sha} · ${currentPath(navigation)}`;

  return (
    <SettingsRow anchor="mmx-version" label={t(($) => $.mmx.version_label)}>
      <div className="flex items-center gap-2">
        <span
          data-testid="mmx-version"
          className="text-caption tabular-nums text-muted-foreground"
        >
          {build.stamp}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={copied ? t(($) => $.mmx.copied) : t(($) => $.mmx.copy)}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(copyValue);
              setCopied(true);
            } catch {
              // Insecure context or a browser that refuses the write: the
              // label stays "Copy" so the reader can retry instead of being
              // told a copy happened that did not.
            }
          }}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
    </SettingsRow>
  );
}
