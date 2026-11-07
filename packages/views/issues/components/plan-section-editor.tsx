"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AskPlanSection } from "@multica/core/issues/ask-plan";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";

/**
 * The Human's editor for one plan section (M-275), ported from the team-room
 * `TeamDocSectionEditor`.
 *
 * The heading and the whole Markdown body are edited together, because a
 * section is one unit of the plan and saving it is one fenced write. When the
 * agent wrote the section again after the edit began, the newer text is shown
 * above the draft: a second save then overwrites it knowingly instead of
 * silently. ⌘/Ctrl+Enter saves, Escape cancels.
 */
export function PlanSectionEditor({
  section,
  baseMarkdown,
  saving,
  save,
  cancel,
}: {
  section: AskPlanSection;
  /** The text this edit started from; a different current text means it moved. */
  baseMarkdown: string;
  saving: boolean;
  save: (heading: string, markdown: string) => void;
  cancel: () => void;
}) {
  const { t } = useT("issues");
  const [heading, setHeading] = useState(section.heading);
  const [markdown, setMarkdown] = useState(baseMarkdown);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const input = bodyRef.current;
    if (input === null) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 480)}px`;
  }, [markdown]);

  const moved = section.markdown !== baseMarkdown;
  const canSave = !saving && heading.trim() !== "";

  const onKey = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) save(heading, markdown);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <form
      data-plan-section-editor={section.sectionId}
      className="rounded-md border border-border bg-background px-3 py-2.5"
      onKeyDown={onKey}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save(heading, markdown);
      }}
    >
      {moved && (
        <div role="status" className="mb-2 border-l-2 border-warning pl-2.5">
          <p className="text-caption text-warning">
            {t(($) => $.ask_plan.edit_stale)}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-caption text-muted-foreground">
            {section.markdown.trim() === ""
              ? t(($) => $.ask_plan.section_empty)
              : section.markdown}
          </p>
        </div>
      )}
      <input
        aria-label={t(($) => $.ask_plan.edit_heading)}
        value={heading}
        disabled={saving}
        onChange={(event) => setHeading(event.currentTarget.value)}
        className="w-full border-0 bg-transparent p-0 text-body font-medium text-foreground outline-none focus-visible:ring-0"
      />
      <textarea
        ref={bodyRef}
        aria-label={t(($) => $.ask_plan.edit_body)}
        value={markdown}
        disabled={saving}
        rows={4}
        onChange={(event) => setMarkdown(event.currentTarget.value)}
        className="mt-1 min-h-20 max-h-[480px] w-full resize-none border-0 bg-transparent p-0 font-mono text-caption leading-5 text-foreground outline-none focus-visible:ring-0"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-caption text-muted-foreground">
          {t(($) => $.ask_plan.edit_shortcut)}
        </span>
        <Button size="xs" variant="ghost" type="button" disabled={saving} onClick={cancel}>
          {t(($) => $.ask_plan.cancel_edit)}
        </Button>
        <Button size="xs" variant="default" type="submit" disabled={!canSave}>
          {saving
            ? t(($) => $.ask_plan.saving_section)
            : t(($) => $.ask_plan.save_section)}
        </Button>
      </div>
    </form>
  );
}
