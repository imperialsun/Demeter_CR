import { describe, expect, it } from "vitest";
import { buildReportDocx, formatReportDocxFilename } from "@/lib/docx/reportDocx";
import type { ReportJson } from "@/lib/llm/reportSchema";

describe("reportDocx", () => {
  it("builds a non-empty blob", async () => {
    const report: ReportJson = {
      format: "CRI",
      title: "Compte rendu test",
      sections: [{ heading: "Contexte", paragraphs: ["Paragraphe 1", "Paragraphe 2"] }],
      key_points: ["Point A"],
    };

    const blob = await buildReportDocx(report, {
      format: "CRI",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      generatedAt: new Date().toISOString(),
      sourceMode: "text",
      sourceTokenCount: 42,
      detailLevel: "verbose",
    });

    expect(blob.size).toBeGreaterThan(0);
  });

  it("formats docx filename", () => {
    const file = formatReportDocxFilename("cro", new Date("2026-02-16T09:05:00Z"), "exhaustive");
    expect(file).toMatch(/^rapport-cro-exhaustive-\d{4}-\d{2}-\d{2}-\d{4}\.docx$/);
  });
});
