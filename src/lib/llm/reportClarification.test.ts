import { describe, expect, it } from "vitest";
import {
  buildClarifiedSourceText,
  buildClarificationSystemPrompt,
  parseReportClarificationJson,
} from "@/lib/llm/reportClarification";

describe("report clarification", () => {
  it("normalizes fenced JSON questions and removes duplicates", () => {
    const result = parseReportClarificationJson(
      '```json\n{"needsClarification":true,"summary":"Contexte incomplet","questions":[{"id":"participants","question":"Qui était présent ?"},{"id":"participants","question":"Doublon"}]}\n```'
    );

    expect(result).toEqual({
      needsClarification: true,
      summary: "Contexte incomplet",
      questions: [{ id: "participants", question: "Qui était présent ?", rationale: undefined }],
    });
  });

  it("extracts clarification JSON surrounded by model commentary", () => {
    const result = parseReportClarificationJson(
      'Voici l\'analyse : {"needsClarification":true,"summary":"","questions":[{"id":"date","question":"Quelle est la date ?"}]} Merci.'
    );

    expect(result.questions[0]?.id).toBe("date");
  });

  it("keeps the original source and appends optional user answers separately", () => {
    const source = "Réunion équipe : budget à revoir.";
    const result = buildClarifiedSourceText(source, [
      { id: "participants", question: "Qui était présent ?", answer: "Alice et Bob" },
      { id: "date", question: "Date ?", answer: "" },
    ]);

    expect(result).toContain(source);
    expect(result).toContain("INFORMATIONS COMPLÉMENTAIRES FOURNIES PAR L'UTILISATEUR:");
    expect(result).toContain("Alice et Bob");
    expect(result).not.toContain("Date ?");
  });

  it("describes an abbreviated Word note conservatively", () => {
    const prompt = buildClarificationSystemPrompt("word_note");
    expect(prompt).toContain("prise de note Word très abrégée");
    expect(prompt).toContain("n'invente jamais de fait");
  });
});
