import { describe, expect, it } from "vitest";
import JSZip from "jszip";
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

  it("uses the readable report format label in the header and body", async () => {
    const report: ReportJson = {
      format: "CRI",
      title: "Compte rendu test",
      sections: [{ heading: "Contexte", paragraphs: ["Paragraphe 1"] }],
    };

    const blob = await buildReportDocx(report, {
      format: "CRI",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      generatedAt: new Date("2026-04-29T12:00:00.000Z").toISOString(),
      sourceMode: "text",
      sourceTokenCount: 42,
    });

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const [headerXml, documentXml] = await Promise.all([
      zip.file("word/header1.xml")?.async("string"),
      zip.file("word/document.xml")?.async("string"),
    ]);

    expect(headerXml).toContain("Rapport Compte rendu détaillé");
    expect(documentXml).toContain("Format: Compte rendu détaillé");
    expect(headerXml).not.toContain("Rapport CRI");
    expect(documentXml).not.toContain("Format: CRI");
  });

  it("renders bold markdown markers as docx bold runs", async () => {
    const report: ReportJson = {
      format: "CRI",
      title: "Compte rendu test",
      sections: [{ heading: "Contexte", paragraphs: ["Point **important** a retenir."] }],
      key_points: ["Decision **validee**"],
    };

    const blob = await buildReportDocx(report, {
      format: "CRI",
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      generatedAt: "2026-04-29T12:00:00.000Z",
      sourceMode: "text",
      sourceTokenCount: 42,
    });
    const arrayBuffer = await blob.arrayBuffer();
    const mammothModule = await import("mammoth/mammoth.browser.js");
    const mammoth = (mammothModule.default ?? mammothModule) as {
      convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
    };

    const result = await mammoth.convertToHtml({ arrayBuffer });

    expect(result.value).toContain("<strong>important</strong>");
    expect(result.value).toContain("<strong>validee</strong>");
    expect(result.value).not.toContain("**important**");
    expect(result.value).not.toContain("**validee**");
  });

  it("formats docx filename", () => {
    const file = formatReportDocxFilename("cro", new Date("2026-02-16T09:05:00Z"), "exhaustive");
    expect(file).toMatch(/^rapport-cro-exhaustive-\d{4}-\d{2}-\d{2}-\d{4}\.docx$/);
  });
});
