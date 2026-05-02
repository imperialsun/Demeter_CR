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

function buildResult(format: ReportResult["format"], paragraph: string, title = "Compte rendu"): ReportResult {
  return {
    format,
    report: {
      format,
      title,
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
        results={{ cri: buildResult("CRI", "Point **important** à retenir.") }}
        enabledFormats={enabledFormats}
        onDownload={vi.fn()}
      />
    );

    const card = screen.getByTestId("report-result-card-cri");
    expect(card).toHaveTextContent("Point important à retenir.");
    expect(card).not.toHaveTextContent("**important**");
    expect(within(card).getByText("important").tagName).toBe("STRONG");
  });

  it("hides disabled formats from the results panel", () => {
    render(
      <ReportFormatResultsPanel
        results={{
          cri: buildResult("CRI", "Point **important** à retenir.", "Compte rendu détaillé"),
          cro: buildResult("CRO", "Texte de test", "Compte rendu opérationnel"),
        }}
        enabledFormats={{
          CRI: true,
          CRO: false,
          CRS: false,
          CRN: false,
        }}
        onDownload={vi.fn()}
      />
    );

    expect(screen.getByTestId("report-result-card-cri")).toBeInTheDocument();
    expect(screen.queryByTestId("report-result-card-cro")).toBeNull();
    expect(screen.queryByTestId("report-result-card-crs")).toBeNull();
    expect(screen.queryByTestId("report-result-card-crn")).toBeNull();
  });
});
