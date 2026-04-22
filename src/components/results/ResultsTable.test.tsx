/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ResultsTable } from "./ResultsTable";
import { useAsrStore } from "@/store/asr-store";

const sample = [
  {
    index: 0,
    start: 0,
    end: 2.3,
    text: "Bonjour le monde",
    confidence: 0.9,
    words: [{ word: "Bonjour", start: 0, end: 0.5 }],
    chunkId: "chunk-1",
    strategy: "chunks",
  },
  { index: 1, start: 2.3, end: 5, text: "Ceci est un test", confidence: 0.5, chunkId: "chunk-2", strategy: "chunks" },
  { index: 2, start: 5, end: 7, text: "Autre segment", confidence: undefined, chunkId: "chunk-3", strategy: "chunks" },
];

const sampleWithSpeaker = [
  {
    index: 0,
    start: 0,
    end: 2,
    text: "Bonjour",
    speaker: "SPEAKER_00",
    chunkId: "chunk-4",
    strategy: "chunks",
  },
];

describe("ResultsTable", () => {
  beforeEach(() => {
    useAsrStore.setState({
      enableWordTimestamps: true,
      showSegmentConfidence: true,
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {},
      },
    } as any);
  });

  function EditableHarness() {
    const [segments, setSegments] = useState(sample as any);
    return (
      <ResultsTable
        segments={segments}
        mode="cloud"
        onSegmentTextChange={(segmentIndex, text) => {
          setSegments((current) =>
            current.map((segment: any) => (segment.index === segmentIndex ? { ...segment, text: text.trim() } : segment))
          );
        }}
      />
    );
  }

  it("renders segments and confidences and filters via search", () => {
    render(<ResultsTable segments={sample as any} />);
    expect(screen.getByText("Bonjour le monde")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("Tokens (est.)")).toBeTruthy();
    expect(screen.getByText("Tokens (est.) : 9")).toBeTruthy();

    const input = screen.getByPlaceholderText("Rechercher un mot clé…");
    fireEvent.change(input, { target: { value: "Ceci" } });
    expect(screen.getByText("Ceci est un test")).toBeTruthy();
    expect(screen.queryByText("Bonjour le monde")).toBeNull();
  });

  it("keeps the legacy internal scroll container when no page scroll context is available", () => {
    render(<ResultsTable segments={sample as any} />);

    expect(screen.getByTestId("results-table-scroll")).toHaveClass("overflow-auto");
    expect(screen.getByTestId("results-table-scroll")).toHaveClass("h-[360px]");
  });

  it("virtualizes long segment lists", () => {
    const longSegments = Array.from({ length: 24 }, (_, index) => ({
      index,
      start: index * 2,
      end: index * 2 + 1,
      text: `Segment ${index + 1}`,
      chunkId: "chunk-long",
      strategy: "chunks" as const,
    }));

    render(<ResultsTable segments={longSegments as any} />);

    expect(screen.getByText("Segment 1")).toBeInTheDocument();
    expect(screen.queryByText("Segment 24")).toBeNull();
    expect(screen.getAllByRole("row").length).toBeLessThan(24);
  });

  it("shows missing confidence as dash", () => {
    render(<ResultsTable segments={sample as any} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows word timestamps when enabled", () => {
    render(<ResultsTable segments={sample as any} />);
    expect(screen.getByText(/\[00:00:00.000 - 00:00:00.500\]/)).toBeTruthy();
  });

  it("auto-shows speaker column when speaker data exists", () => {
    render(<ResultsTable segments={sampleWithSpeaker as any} mode="cloud" />);
    expect(screen.getByRole("columnheader", { name: /intervenant/i })).toBeInTheDocument();
    expect(screen.getByText("SPEAKER_00")).toBeInTheDocument();
  });

  it("shows assigned speaker name when assignment exists", () => {
    useAsrStore.setState({
      speakerAssignments: {
        upload: {
          SPEAKER_00: {
            firstName: "Alice",
            lastName: "Dupont",
          },
        },
        mic: {},
        cloud: {},
      },
    } as any);

    render(<ResultsTable segments={sampleWithSpeaker as any} mode="upload" />);
    expect(screen.getByText("Dupont Alice")).toBeInTheDocument();
    expect(screen.queryByText("SPEAKER_00")).toBeNull();
  });

  it("resolves cloud speaker assignments per chunk key", () => {
    useAsrStore.setState({
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {
          "chunk-4::SPEAKER_00": {
            firstName: "Alice",
            lastName: "Dupont",
          },
        },
      },
    } as any);

    render(<ResultsTable segments={sampleWithSpeaker as any} mode="cloud" />);
    expect(screen.getByText("Dupont Alice")).toBeInTheDocument();
    expect(screen.queryByText("SPEAKER_00")).toBeNull();
  });

  it("lets cloud users reassign a segment speaker with resolved option labels", async () => {
    useAsrStore.setState({
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {
          "chunk-4::SPEAKER_00": {
            firstName: "Alice",
            lastName: "Dupont",
          },
          "chunk-4::SPEAKER_01": {
            firstName: "Bob",
            lastName: "Martin",
          },
        },
      },
    } as any);

    function SpeakerHarness() {
      const [segments, setSegments] = useState([
        {
          index: 0,
          start: 0,
          end: 2,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          chunkId: "chunk-4",
          strategy: "chunks" as const,
        },
        {
          index: 1,
          start: 2,
          end: 4,
          text: "Salut",
          speaker: "SPEAKER_00",
          chunkId: "chunk-4",
          strategy: "chunks" as const,
        },
        {
          index: 2,
          start: 4,
          end: 6,
          text: "Réponse",
          speaker: "SPEAKER_01",
          chunkId: "chunk-4",
          strategy: "chunks" as const,
        },
      ]);

      return (
        <ResultsTable
          segments={segments as any}
          mode="cloud"
          speakerOptions={[
            { value: "SPEAKER_00", label: "Dupont Alice · SPEAKER_00" },
            { value: "SPEAKER_01", label: "Martin Bob · SPEAKER_01" },
          ]}
          onSegmentSpeakerChange={(segmentIndex, speakerId) => {
            setSegments((current) =>
              current.map((segment) => (segment.index === segmentIndex ? { ...segment, speaker: speakerId } : segment))
            );
          }}
        />
      );
    }

    render(<SpeakerHarness />);

    const firstSpeakerSelect = screen.getByRole("combobox", { name: /intervenant du segment 1/i });
    const secondSpeakerSelect = screen.getByRole("combobox", { name: /intervenant du segment 2/i });

    expect(firstSpeakerSelect).toHaveTextContent("Dupont Alice · SPEAKER_00");
    expect(secondSpeakerSelect).toHaveTextContent("Dupont Alice · SPEAKER_00");

    fireEvent.click(firstSpeakerSelect);
    fireEvent.click(screen.getByRole("option", { name: "Martin Bob · SPEAKER_01" }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /intervenant du segment 1/i })).toHaveTextContent(
        "Martin Bob · SPEAKER_01"
      );
      expect(screen.getByRole("combobox", { name: /intervenant du segment 2/i })).toHaveTextContent(
        "Dupont Alice · SPEAKER_00"
      );
    });
  });

  it("falls back to raw speaker when assignment is missing", () => {
    render(<ResultsTable segments={sampleWithSpeaker as any} mode="mic" />);
    expect(screen.getByText("SPEAKER_00")).toBeInTheDocument();
  });

  it("hides segment editing controls when editing is disabled", () => {
    render(<ResultsTable segments={sample as any} onSegmentTextChange={vi.fn()} segmentEditingDisabled />);
    expect(screen.queryByRole("button", { name: /modifier le segment 1/i })).toBeNull();
    expect(screen.queryByText(/modifier sa transcription localement/i)).toBeNull();
  });

  it("opens a segment editor and applies the edited text", async () => {
    render(<EditableHarness />);

    fireEvent.click(screen.getByRole("button", { name: /modifier le segment 1/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/texte du segment/i), {
      target: { value: "Bonjour modifié" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enregistrer/i }));

    await waitFor(() => {
      expect(screen.getByText("Bonjour modifié")).toBeInTheDocument();
    });
  });
});
