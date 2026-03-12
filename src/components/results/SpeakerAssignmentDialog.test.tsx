import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakerAssignmentDialog } from "./SpeakerAssignmentDialog";

describe("SpeakerAssignmentDialog", () => {
  it("groups cloud speaker assignments by chunk and keeps local drafts isolated", () => {
    const onApply = vi.fn();

    render(
      <SpeakerAssignmentDialog
        mode="cloud"
        entries={[
          {
            assignmentKey: "mistral-1::SPEAKER_00",
            chunkId: "mistral-1",
            chunkLabel: "Chunk 1",
            speakerId: "SPEAKER_00",
            start: 0,
            end: 10,
          },
          {
            assignmentKey: "mistral-2::SPEAKER_00",
            chunkId: "mistral-2",
            chunkLabel: "Chunk 2",
            speakerId: "SPEAKER_00",
            start: 10,
            end: 20,
          },
        ]}
        assignments={{}}
        onApply={onApply}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("Assigner les speakers par chunk")).toBeInTheDocument();
    expect(screen.getByText("Chunk 1")).toBeInTheDocument();
    expect(screen.getByText("Chunk 2")).toBeInTheDocument();
    expect(screen.getByText("ID technique: mistral-1")).toBeInTheDocument();
    expect(screen.getByText("ID technique: mistral-2")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Nom Chunk 1 SPEAKER_00"), { target: { value: "Dupont" } });
    fireEvent.change(screen.getByLabelText("Prénom Chunk 1 SPEAKER_00"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));

    expect(onApply).toHaveBeenCalledWith({
      "mistral-1::SPEAKER_00": {
        firstName: "Alice",
        lastName: "Dupont",
      },
    });
  });
});
