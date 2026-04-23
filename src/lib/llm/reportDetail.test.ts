import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORT_DETAIL_LEVELS,
  REPORT_DETAIL_TARGETS,
  buildReportDetailSummary,
  buildReportDetailTargetLabel,
  computeReportDetailTargetWordCount,
  buildReportDetailPromptRules,
  normalizeReportDetailLevels,
  reportDetailIndexToLevel,
  reportDetailLevelToIndex,
} from "@/lib/llm/reportDetail";

describe("reportDetail", () => {
  it("exposes the target ratios and qualitative labels for each report format and detail level", () => {
    expect(REPORT_DETAIL_TARGETS.CRI.standard).toEqual({ ratio: 0.05, label: "compact" });
    expect(REPORT_DETAIL_TARGETS.CRI.verbose).toEqual({ ratio: 0.1, label: "developpe" });
    expect(REPORT_DETAIL_TARGETS.CRI.exhaustive).toEqual({ ratio: 0.15, label: "tres detaille" });
    expect(REPORT_DETAIL_TARGETS.CRO.standard).toEqual({ ratio: 0.025, label: "compact" });
    expect(REPORT_DETAIL_TARGETS.CRO.verbose).toEqual({ ratio: 0.05, label: "developpe" });
    expect(REPORT_DETAIL_TARGETS.CRO.exhaustive).toEqual({ ratio: 0.075, label: "tres detaille" });
    expect(REPORT_DETAIL_TARGETS.CRS.standard).toEqual({ ratio: 0.0125, label: "compact" });
    expect(REPORT_DETAIL_TARGETS.CRS.verbose).toEqual({ ratio: 0.025, label: "developpe" });
    expect(REPORT_DETAIL_TARGETS.CRS.exhaustive).toEqual({ ratio: 0.0375, label: "tres detaille" });
  });

  it("normalizes persisted report detail levels and falls back to defaults", () => {
    expect(
      normalizeReportDetailLevels(
        {
          CRI: "verbose",
          CRO: "invalid",
        },
        DEFAULT_REPORT_DETAIL_LEVELS
      )
    ).toEqual({
      CRI: "verbose",
      CRO: "standard",
      CRS: "standard",
    });
  });

  it("maps slider indexes to detail levels and back", () => {
    expect(reportDetailLevelToIndex("standard")).toBe(0);
    expect(reportDetailLevelToIndex("verbose")).toBe(1);
    expect(reportDetailLevelToIndex("exhaustive")).toBe(2);
    expect(reportDetailIndexToLevel(-1)).toBe("standard");
    expect(reportDetailIndexToLevel(1)).toBe("verbose");
    expect(reportDetailIndexToLevel(8)).toBe("exhaustive");
  });

  it("builds floor-based prompt rules from the calculated word count", () => {
    const sourceText = Array.from({ length: 40 }, (_, index) => `mot${index + 1}`).join(" ");
    const rules = buildReportDetailPromptRules("CRO", "verbose", sourceText);

    expect(rules[0]).toContain("longueur minimale obligatoire");
    expect(rules[0]).toContain("base minimale");
    expect(rules[0]).toContain("2 mots");
    expect(rules[1]).toContain("minimum, pas un plafond");
    expect(rules[2]).toContain("tu peux depasser");
    expect(rules[3]).toContain("verbeux");
    expect(rules[4]).toContain("interlocuteurs sont nommes");
    expect(rules.join(" ")).not.toContain("%");
  });

  it("builds qualitative display labels without percentages", () => {
    expect(buildReportDetailTargetLabel("CRI", "standard")).toBe("compact");
    expect(buildReportDetailTargetLabel("CRO", "verbose")).toBe("developpe");
    expect(buildReportDetailTargetLabel("CRS", "exhaustive")).toBe("tres detaille");
    expect(buildReportDetailSummary("CRO", "verbose")).toBe("Verbeux · developpe");
  });

  it("computes the expected target word count from the source size", () => {
    expect(computeReportDetailTargetWordCount("CRI", "standard", 100)).toBe(5);
    expect(computeReportDetailTargetWordCount("CRO", "verbose", 100)).toBe(5);
    expect(computeReportDetailTargetWordCount("CRS", "exhaustive", 100)).toBe(4);
  });
});
