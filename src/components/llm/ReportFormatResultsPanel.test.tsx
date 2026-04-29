import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportFormatResultsPanel } from "@/components/llm/ReportFormatResultsPanel";
import type { ReportResult } from "@/lib/llm/reportSchema";

const enabledFormats = {
  CRI: true,
  CRO: true,
  CRS: true,
  CRN: true,
};

function buildResult(paragraph: string): ReportResult {
  return {
    format: "CRI",
    report: {
      format: "CRI",
      title: "Compte rendu",
      sections: [{ heading: "Synthèse", paragraphs: [paragraph] }],
    },
    rawResponse: "{}",
    modelId: "test-model",
    generatedAt: "2026-04-29T12:00:00.000Z",
    sourceMode: "text",
    sourceTokenCount: 12,
    pipelinePasses: 1,
    strategy: "chatCompletion",
  };
}

describe("ReportFormatResultsPanel", () => {
  it("renders bold markdown in report previews without showing markers", () => {
    render(
      <ReportFormatResultsPanel
        results={{ cri: buildResult("Point **important** à retenir.") }}
        enabledFormats={enabledFormats}
        onDownload={vi.fn()}
      />
    );

    const card = screen.getByTestId("report-result-card-cri");
    expect(card).toHaveTextContent("Point important à retenir.");
    expect(card).not.toHaveTextContent("**important**");
    expect(within(card).getByText("important").tagName).toBe("STRONG");
  });
});
