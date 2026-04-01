/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExportButtons } from "./ExportButtons";
import * as exportLib from "@/lib/export";
import { useAsrStore } from "@/store/asr-store";

const transcriptDocxMocks = vi.hoisted(() => ({
  buildTranscriptDocx: vi.fn(async () => new Blob(["docx"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })),
  downloadDocxBlob: vi.fn(),
  formatTranscriptDocxFilename: vi.fn(() => "transcription-brute-2026-02-16-0905.docx"),
}));

vi.mock("@/lib/export", async () => ({
  ...(await vi.importActual("@/lib/export")),
  downloadBlob: vi.fn(),
  serializeVtt: vi.fn(() => "vtt"),
  serializeSrt: vi.fn(() => "srt"),
  serializeSegmentsJson: vi.fn(() => "json"),
  serializeTelemetry: vi.fn(() => "telemetry"),
}));

vi.mock("@/lib/docx/transcriptDocx", async () => ({
  ...(await vi.importActual("@/lib/docx/transcriptDocx")),
  buildTranscriptDocx: transcriptDocxMocks.buildTranscriptDocx,
  downloadDocxBlob: transcriptDocxMocks.downloadDocxBlob,
  formatTranscriptDocxFilename: transcriptDocxMocks.formatTranscriptDocxFilename,
}));

describe("ExportButtons", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    transcriptDocxMocks.buildTranscriptDocx.mockClear();
    transcriptDocxMocks.downloadDocxBlob.mockClear();
    transcriptDocxMocks.formatTranscriptDocxFilename.mockClear();
    useAsrStore.setState({
      showExportVtt: true,
      showExportSrt: true,
      showExportJson: true,
      showExportTelemetry: true,
      audioSource: null,
      uploadedFile: null,
      runExportHeaders: {
        upload: null,
        mic: null,
        cloud: null,
      },
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {},
      },
    } as any);
  });

  it("renders buttons based on store flags and triggers download", () => {
    const downloadSpy = vi.spyOn(exportLib, "downloadBlob");
    const segments: any[] = [{ index: 0, start: 0, end: 1, text: "a", chunkId: "chunk-1", strategy: "chunks" }];
    const telemetry = { sessionId: "s1" } as any;

    render(<ExportButtons segments={segments} telemetry={telemetry} />);

    const vtt = screen.getByText("VTT");
    const srt = screen.getByText("SRT");
    const json = screen.getByText("JSON");
    const tele = screen.getByText("Telemetry");

    expect(vtt).toBeTruthy();
    expect(srt).toBeTruthy();
    expect(json).toBeTruthy();
    expect(tele).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Télécharger en DOCX$/i })).toBeNull();

    fireEvent.click(vtt);
    fireEvent.click(srt);
    fireEvent.click(json);
    fireEvent.click(tele);

    expect(downloadSpy).toHaveBeenCalled();
    expect((exportLib.serializeVtt as any)).toHaveBeenCalled();
    const vttCalls = (exportLib.serializeVtt as any).mock.calls;
    const lastVttPayload = vttCalls[vttCalls.length - 1][0];
    expect(lastVttPayload[0]).toMatchObject({ text: "a" });
    expect((exportLib.serializeTelemetry as any)).toHaveBeenCalledWith(telemetry, expect.any(Object));
  });

  it("renders the docx export only when enabled and downloads the transcript docx", async () => {
    useAsrStore.setState({
      audioSource: {
        id: "upload:session.wav:1",
        label: "session.wav",
        type: "file",
      },
      uploadedFile: new File(["audio"], "session.wav", { type: "audio/wav" }),
    } as any);

    const segments: any[] = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Bonjour",
        speaker: "Alice",
        chunkId: "chunk-1",
        strategy: "chunks",
      },
    ];

    render(<ExportButtons segments={segments} showDocx mode="upload" />);

    const docxButton = screen.getByRole("button", { name: /^Télécharger en DOCX$/i });
    fireEvent.click(docxButton);

    await waitFor(() => {
      expect(transcriptDocxMocks.buildTranscriptDocx).toHaveBeenCalledTimes(1);
      expect(transcriptDocxMocks.downloadDocxBlob).toHaveBeenCalledTimes(1);
    });

    expect(transcriptDocxMocks.buildTranscriptDocx).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ text: "Bonjour", speaker: "Alice" })]),
      expect.objectContaining({
        sourceMode: "upload",
        sourceLabel: "session.wav",
        generatedAt: expect.any(String),
      })
    );
    expect(transcriptDocxMocks.formatTranscriptDocxFilename).toHaveBeenCalledWith(expect.any(Date));
    expect(transcriptDocxMocks.downloadDocxBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      "transcription-brute-2026-02-16-0905.docx"
    );
  });

  it("disables export buttons when there is no data", () => {
    const segments: any[] = [];
    render(<ExportButtons segments={segments} />);
    const vtt = screen.getByText("VTT").closest("button");
    expect(vtt).toBeDisabled();
  });

  it("respects explicit show flags over store defaults", () => {
    useAsrStore.setState({
      showExportVtt: true,
      showExportSrt: true,
      showExportJson: true,
      showExportTelemetry: true,
    } as any);

    const segments: any[] = [{ index: 0, start: 0, end: 1, text: "a", chunkId: "chunk-1", strategy: "chunks" }];
    const telemetry = { sessionId: "s1" } as any;
    render(
      <ExportButtons
        segments={segments}
        telemetry={telemetry}
        showVtt={false}
        showJson={false}
        showTelemetry={false}
      />
    );

    expect(screen.queryByText("VTT")).toBeNull();
    expect(screen.queryByText("JSON")).toBeNull();
    expect(screen.queryByText("Telemetry")).toBeNull();
    expect(screen.getByText("SRT")).toBeTruthy();
  });

  it("uses run snapshot header so exports reflect effective run settings", () => {
    const segments: any[] = [{ index: 0, start: 0, end: 1, text: "a", chunkId: "chunk-1", strategy: "chunks" }];
    useAsrStore.setState({
      activePreset: "quality",
      runExportHeaders: {
        upload: {
          exportedAt: "2026-02-19T00:00:00.000Z",
          mode: "upload",
          settings: {
            file: {
              modelPreset: "fast",
              memoryModeEffective: "progressive",
            },
          },
          runtime: {
            activeBackend: "wasm",
          },
        },
        mic: null,
        cloud: null,
      },
    } as any);

    render(<ExportButtons segments={segments} mode="upload" />);
    fireEvent.click(screen.getByText("JSON"));

    expect((exportLib.serializeSegmentsJson as any)).toHaveBeenCalled();
    const jsonCalls = (exportLib.serializeSegmentsJson as any).mock.calls;
    const header = jsonCalls[jsonCalls.length - 1][1];
    expect(header.mode).toBe("upload");
    expect(header.settings.file).toEqual({
      modelPreset: "fast",
      memoryModeEffective: "progressive",
    });
    expect(header.settings.mic).toBeUndefined();
    expect(header.settings.cloud).toBeUndefined();
    expect(header.runtime).toEqual({ activeBackend: "wasm" });
    expect(typeof header.exportedAt).toBe("string");
  });

  it("shows assign speakers button only when speaker data exists", () => {
    const withSpeaker: any[] = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "a",
        speaker: "SPEAKER_00",
        chunkId: "chunk-1",
        strategy: "chunks",
      },
    ];
    const withoutSpeaker: any[] = [{ index: 0, start: 0, end: 1, text: "a", chunkId: "chunk-1", strategy: "chunks" }];

    const { rerender } = render(<ExportButtons segments={withSpeaker} />);
    expect(screen.getByRole("button", { name: /Assigner speakers/i })).toBeInTheDocument();

    rerender(<ExportButtons segments={withoutSpeaker} />);
    expect(screen.queryByRole("button", { name: /Assigner speakers/i })).toBeNull();
  });

  it("hides the assign speakers button in cloud mode", () => {
    const segments: any[] = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "a",
        speaker: "SPEAKER_00",
        chunkId: "chunk-1",
        strategy: "chunks",
      },
    ];

    render(<ExportButtons segments={segments} mode="cloud" />);

    expect(screen.queryByRole("button", { name: /Assigner speakers/i })).toBeNull();
  });

  it("applies speaker assignments before exporting json", () => {
    const segments: any[] = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Bonjour",
        speaker: "SPEAKER_00",
        chunkId: "chunk-1",
        strategy: "chunks",
      },
      {
        index: 1,
        start: 2,
        end: 3,
        text: "Salut",
        speaker: "SPEAKER_00",
        chunkId: "chunk-2",
        strategy: "chunks",
      },
    ];

    useAsrStore.setState({
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {
          "chunk-1::SPEAKER_00": {
            firstName: "Alice",
            lastName: "Dupont",
          },
        },
      },
    } as any);

    render(<ExportButtons segments={segments} mode="cloud" />);

    fireEvent.click(screen.getByText("JSON"));

    const jsonCalls = (exportLib.serializeSegmentsJson as any).mock.calls;
    const payload = jsonCalls[jsonCalls.length - 1][0];
    expect(payload[0]?.speaker).toBe("Dupont Alice");
    expect(payload[1]?.speaker).toBe("SPEAKER_00");
  });
});
