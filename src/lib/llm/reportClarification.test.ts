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
