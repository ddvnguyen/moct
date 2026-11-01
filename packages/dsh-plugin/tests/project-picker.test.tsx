import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectPicker } from "../src/client/project-picker";

const longTitle = "A".repeat(60);

describe("ProjectPicker", () => {
  it("renders the full long title in the trigger", () => {
    render(
      <ProjectPicker
        projects={[{ id: "p1", title: longTitle } as any]}
        projectId="p1"
        onSelect={vi.fn()}
      />,
    );
    const trigger = screen.getByLabelText("Project");
    expect(trigger).toHaveTextContent(longTitle);
    expect(trigger.className).toContain("max-w-[240px]");
  });

  it("opens the dropdown and shows the long title", () => {
    render(
      <ProjectPicker
        projects={[{ id: "p1", title: longTitle } as any]}
        projectId={null}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Project"));
    expect(screen.getByText(longTitle)).toBeInTheDocument();
  });
});
