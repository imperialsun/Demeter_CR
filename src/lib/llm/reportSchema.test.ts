import { describe, expect, it } from "vitest";
import { parseReportJson } from "@/lib/llm/reportSchema";

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
});
