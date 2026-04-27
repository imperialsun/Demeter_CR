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

  it("adds a prioritized system note when a detail level is provided", () => {
    const prompt = buildReportSystemPrompt("exhaustive");
    expect(prompt).toContain("Niveau de detail actif: Exhaustif");
    expect(prompt).toContain("base minimale");
    expect(prompt).toContain("minimum obligatoire");
    expect(prompt).toContain("pas comme une moyenne ni un plafond");
    expect(prompt).toContain("Respecte cette contrainte");
  });

  it("builds format-specific user prompt", () => {
    const prompt = buildReportUserPrompt("CRI", "Texte source");
    expect(prompt).toContain("Format cible: CRI");
    expect(prompt).toContain('"format": "CRI"');
    expect(prompt).toContain("SOURCE:");
  });

  it("keeps the default prompt free of detail-level constraints", () => {
    const prompt = buildReportUserPrompt("CRI", "Texte source");
    expect(prompt).not.toContain("Consigne prioritaire de longueur");
    expect(prompt).not.toContain("longueur minimale obligatoire");
    expect(prompt).not.toContain("interlocuteurs sont nommes");
  });

  it("injects the report detail level and named-speaker rule", () => {
    const prompt = buildReportUserPrompt("CRO", "un texte source de test", "exhaustive");
    expect(prompt).toContain("Consigne prioritaire de longueur");
    expect(prompt).toContain("longueur minimale obligatoire");
    expect(prompt).toContain("au moins");
    expect(prompt).toContain("minimum, pas un plafond");
    expect(prompt).toContain("tu peux depasser");
    expect(prompt).toContain("le plus long et le plus detaille");
    expect(prompt).toContain("interlocuteurs sont nommes");
    expect(prompt).not.toContain("workflow multi-pass");
    expect(prompt).not.toContain("sous-parties");
    expect(prompt.indexOf("Consigne prioritaire de longueur")).toBeLessThan(
      prompt.indexOf("Retourne uniquement un JSON valide")
    );
  });

  it("applies specific style rules for CRI/CRO/CRS/CRN", () => {
    const criPrompt = buildReportUserPrompt("CRI", "Texte source");
    const croPrompt = buildReportUserPrompt("CRO", "Texte source");
    const crsPrompt = buildReportUserPrompt("CRS", "Texte source");
    const crnPrompt = buildReportUserPrompt("CRN", "Texte source", "standard");

    expect(criPrompt).toContain("style narratif et textuel");
    expect(criPrompt).toContain("plusieurs pages");
    expect(croPrompt).toContain("style operationnel");
    expect(crsPrompt).toContain("style ultra synthetique");
    expect(crsPrompt).toContain("2-3 sections");
    expect(crnPrompt).toContain("Format cible: CRN");
    expect(crnPrompt).toContain("procès-verbal narratif");
    expect(crnPrompt).toContain("ordre du jour");
    expect(crnPrompt).toContain("interventions aux personnes ou groupes");
    expect(crnPrompt).toContain("au moins");
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
