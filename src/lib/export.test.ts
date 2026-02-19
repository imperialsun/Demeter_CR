import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadBlob,
  serializeSegmentsJson,
  serializeSrt,
  serializeTelemetry,
  serializeVtt,
  type ExportHeader,
  type TranscriptionSegment,
} from "@/lib/export";

const header: ExportHeader = {
  exportedAt: "2026-02-18T00:00:00.000Z",
  mode: "upload",
  settings: {
    file: { model: "fast" },
    mic: {},
  },
  runtime: { backend: "wasm" },
};

const segments: TranscriptionSegment[] = [
  {
    index: 0,
    start: 0.125,
    end: 2.345,
    text: "  Bonjour   monde  ",
    speaker: "Dupont Alice",
    chunkId: "chunk-1",
    strategy: "chunks",
  },
  {
    index: 1,
    start: 3723.9, // > 1h
    end: 3725.02,
    text: "Ça va ?",
    chunkId: "chunk-2",
    strategy: "chunks",
  },
];

describe("export serialization", () => {
  it("serializes VTT with metadata block and timestamps", () => {
    const out = serializeVtt(segments, header);
    expect(out).toContain("WEBVTT");
    expect(out).toContain("NOTE SETTINGS");
    expect(out).toContain('"backend": "wasm"');
    expect(out).toContain("00:00:00.125 --> 00:00:02.345");
    expect(out).toContain("01:02:03.900 --> 01:02:05.019");
    expect(out).toContain("Dupont Alice: Bonjour   monde");
  });

  it("serializes SRT with NOTE SETTINGS and comma milliseconds", () => {
    const out = serializeSrt(segments, header);
    expect(out).toContain("NOTE SETTINGS");
    expect(out).toContain("00:00:00,125 --> 00:00:02,345");
    expect(out).toContain("01:02:03,900 --> 01:02:05,019");
    expect(out).toContain("Dupont Alice: Bonjour   monde");
  });

  it("serializes trimmed segments JSON with speaker field", () => {
    const out = serializeSegmentsJson(segments, header);
    const parsed = JSON.parse(out) as { segments: Array<{ text: string; speaker?: string }> };
    expect(parsed.segments[0]?.text).toBe("Bonjour   monde");
    expect(parsed.segments[0]?.speaker).toBe("Dupont Alice");
  });

  it("serializes telemetry payload", () => {
    const out = serializeTelemetry(
      {
        events: [{ type: "TEST_EVENT", at: 1, payload: { ok: true } }],
        chunkMetrics: [],
        timers: {},
        alerts: [],
      },
      header
    );
    const parsed = JSON.parse(out) as { telemetry: { events: Array<{ type: string }> } };
    expect(parsed.telemetry.events[0]?.type).toBe("TEST_EVENT");
  });
});

describe("downloadBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a temporary anchor and revokes object URL", () => {
    const click = vi.fn();
    const anchor = {
      href: "",
      download: "",
      click,
    } as unknown as HTMLAnchorElement;
    const createElementSpy = vi.spyOn(document, "createElement").mockReturnValue(anchor);
    const createUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-url");
    const revokeUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    downloadBlob("hello", "test.txt", "text/plain");

    expect(createElementSpy).toHaveBeenCalledWith("a");
    expect(anchor.download).toBe("test.txt");
    expect(anchor.href).toBe("blob:test-url");
    expect(click).toHaveBeenCalledTimes(1);
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    expect(revokeUrlSpy).toHaveBeenCalledWith("blob:test-url");
  });
});
