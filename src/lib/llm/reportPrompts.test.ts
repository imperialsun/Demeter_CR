import { describe, it, expect } from "vitest";
import {
  buildReportSystemPrompt,
  buildReportUserPrompt,
  buildLongInputChunkPrompt,
  buildLongInputConsolidationPrompt,
} from "@/lib/llm/reportPrompts";

describe("reportPrompts", () => {
  it("builds a strict system prompt", () => {
    const prompt = buildReportSystemPrompt();
    expect(prompt).toContain("N'invente jamais");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("transcription ASR");
    expect(prompt).toContain("Corrige uniquement les erreurs manifestes");
  });

  it("builds format-specific user prompt", () => {
    const prompt = buildReportUserPrompt("CRI", "Texte source");
    expect(prompt).toContain("Format cible: CRI");
    expect(prompt).toContain('"format": "CRI"');
    expect(prompt).toContain("SOURCE:");
  });

  it("applies specific style rules for CRI/CRO/CRS", () => {
    const criPrompt = buildReportUserPrompt("CRI", "Texte source");
    const croPrompt = buildReportUserPrompt("CRO", "Texte source");
    const crsPrompt = buildReportUserPrompt("CRS", "Texte source");

    expect(criPrompt).toContain("style narratif et textuel");
    expect(criPrompt).toContain("plusieurs pages");
    expect(croPrompt).toContain("style operationnel");
    expect(crsPrompt).toContain("style ultra synthetique");
    expect(crsPrompt).toContain("2-3 sections");
  });

  it("builds chunk extraction prompts", () => {
    const prompts = buildLongInputChunkPrompt("abc", 1, 3);
    expect(prompts.systemPrompt).toContain("extraction factuelle");
    expect(prompts.userPrompt).toContain("Chunk 2/3");
  });

  it("builds consolidation prompt", () => {
    const prompts = buildLongInputConsolidationPrompt(["A", "B"]);
    expect(prompts.userPrompt).toContain("Resume 1");
    expect(prompts.userPrompt).toContain("Resume 2");
  });
});
