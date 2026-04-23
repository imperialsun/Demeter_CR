import { describe, expect, it, vi } from "vitest";
import { prepareLongInputForReports, splitTextIntoTokenChunks } from "@/lib/llm/longInputPipeline";

describe("longInputPipeline", () => {
  it("returns direct source for short input", async () => {
    const summarizeChunk = vi.fn(async () => "summary");
    const consolidate = vi.fn(async () => "consolidated");

    const result = await prepareLongInputForReports({
      sourceText: "Texte court",
      thresholdTokens: 50,
      summarizeChunk,
      consolidateSummaries: consolidate,
    });

    expect(result.pipelinePasses).toBe(1);
    expect(result.text).toBe("Texte court");
    expect(summarizeChunk).not.toHaveBeenCalled();
    expect(consolidate).not.toHaveBeenCalled();
  });

  it("splits long input and consolidates", async () => {
    const source = Array.from({ length: 3000 }, (_, i) => `mot${i}`).join(" ");
    const summarizeChunk = vi.fn(async (chunk: string) => `summary:${chunk.slice(0, 12)}`);
    const consolidate = vi.fn(async (summaries: string[]) => summaries.join("\n"));

    const result = await prepareLongInputForReports({
      sourceText: source,
      thresholdTokens: 100,
      chunkTokens: 500,
      chunkOverlapTokens: 50,
      summarizeChunk,
      consolidateSummaries: consolidate,
    });

    expect(result.pipelinePasses).toBe(2);
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(summarizeChunk).toHaveBeenCalledTimes(result.chunkCount);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("summary:");
  });

  it("targets half-size chunks when the ratio is 50%", async () => {
    const source = Array.from({ length: 3000 }, (_, i) => `mot${i}`).join(" ");
    const summarizeChunk = vi.fn(async (chunk: string) => `summary:${chunk.slice(0, 12)}`);
    const consolidate = vi.fn(async (summaries: string[]) => summaries.join("\n"));

    const result = await prepareLongInputForReports({
      sourceText: source,
      thresholdTokens: 2000,
      chunkTokens: 2400,
      chunkRatio: 0.5,
      chunkOverlapTokens: 50,
      summarizeChunk,
      consolidateSummaries: consolidate,
    });

    expect(result.pipelinePasses).toBe(2);
    expect(result.chunkCount).toBe(3);
    expect(summarizeChunk).toHaveBeenCalledTimes(3);
    expect(summarizeChunk.mock.calls[0]?.[0].trim().split(/\s+/)).toHaveLength(1500);
  });

  it("lets the ratio override the model chunk hint when the source is long enough", async () => {
    const source = Array.from({ length: 6000 }, (_, i) => `mot${i}`).join(" ");
    const summarizeChunk = vi.fn(async (chunk: string) => `summary:${chunk.slice(0, 12)}`);
    const consolidate = vi.fn(async (summaries: string[]) => summaries.join("\n"));

    const result = await prepareLongInputForReports({
      sourceText: source,
      thresholdTokens: 5000,
      chunkTokens: 1000,
      chunkRatio: 0.5,
      chunkOverlapTokens: 0,
      summarizeChunk,
      consolidateSummaries: consolidate,
    });

    expect(result.pipelinePasses).toBe(2);
    expect(result.chunkCount).toBe(2);
    expect(summarizeChunk).toHaveBeenCalledTimes(2);
    expect(summarizeChunk.mock.calls[0]?.[0].trim().split(/\s+/)).toHaveLength(3000);
  });

  it("creates overlapping chunks", () => {
    const text = Array.from({ length: 30 }, (_, i) => `x${i}`).join(" ");
    const chunks = splitTextIntoTokenChunks(text, 10, 2);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toContain("x8");
    expect(chunks[1]).toContain("x8");
  });
});
