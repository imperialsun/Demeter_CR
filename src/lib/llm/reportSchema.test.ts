import { describe, expect, it } from "vitest";
import { areReportJsonsEqual, cloneReportJson, parseReportJson } from "@/lib/llm/reportSchema";

describe("reportSchema", () => {
  it("parses fenced JSON output", () => {
    const input = `\`\`\`json\n{
      "format": "CRI",
      "title": "Titre",
      "sections": [
        { "heading": "Contexte", "paragraphs": ["Ligne 1", "Ligne 2"] }
      ],
      "caveats": ["Incertitude"]
    }\n\`\`\``;

    const report = parseReportJson(input, "CRI");
    expect(report.format).toBe("CRI");
    expect(report.title).toBe("Titre");
    expect(report.sections).toHaveLength(1);
    expect(report.caveats).toEqual(["Incertitude"]);
  });

  it("clones reports deeply and compares them structurally", () => {
    const report = {
      format: "CRO" as const,
      title: "Titre",
      subtitle: "Sous titre",
      sections: [{ heading: "Contexte", paragraphs: ["Paragraphe 1"] }],
      key_points: ["Point 1"],
      action_items: ["Action 1"],
      caveats: ["Vigilance 1"],
    };

    const clone = cloneReportJson(report);
    expect(clone).not.toBe(report);
    expect(areReportJsonsEqual(clone, report)).toBe(true);

    clone.sections[0]!.paragraphs[0] = "Paragraphe modifie";
    expect(report.sections[0]?.paragraphs[0]).toBe("Paragraphe 1");
    expect(areReportJsonsEqual(clone, report)).toBe(false);
  });

  it("throws on invalid structure", () => {
    const input = JSON.stringify({ format: "CRI", title: "Titre", sections: [] });
    expect(() => parseReportJson(input, "CRI")).toThrow(/aucune section/i);
  });

  it("normalizes optional arrays", () => {
    const input = JSON.stringify({
      format: "CRO",
      title: "Titre",
      sections: [{ heading: "Synthese", paragraphs: ["ok"] }],
      key_points: [" A ", "", "B"],
    });

    const report = parseReportJson(input, "CRO");
    expect(report.key_points).toEqual(["A", "B"]);
  });

  it("parses json with trailing commas", () => {
    const input = `{
      "format": "CRI",
      "title": "Titre",
      "sections": [
        { "heading": "Contexte", "paragraphs": ["A",] },
      ],
    }`;

    const report = parseReportJson(input, "CRI");
    expect(report.format).toBe("CRI");
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]?.heading).toBe("Contexte");
  });

  it("extracts and parses json object from surrounding text", () => {
    const input = `Analyse:
{
  "format": "CRS",
  "title": "Titre court",
  "sections": [{ "heading": "Synthese", "paragraphs": ["Texte"] }]
}
Fin de sortie`;

    const report = parseReportJson(input, "CRS");
    expect(report.format).toBe("CRS");
    expect(report.title).toBe("Titre court");
  });

  it("accepts the narrative report format", () => {
    const input = JSON.stringify({
      format: "CRN",
      title: "Compte rendu narratif",
      sections: [{ heading: "1. Ouverture", paragraphs: ["Mme X ouvre la séance."] }],
    });

    const report = parseReportJson(input, "CRN");
    expect(report.format).toBe("CRN");
    expect(report.sections[0]?.heading).toBe("1. Ouverture");
  });
});
