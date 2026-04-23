import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  generateCloudMultiPassReport,
  resolveWorkflowChunkWordCount,
} from "@/lib/llm/reportWorkflow";

function makeWords(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}

describe("reportWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes chunk size at half of the source by default", () => {
    expect(resolveWorkflowChunkWordCount(1000, 0.5)).toBe(500);
    expect(resolveWorkflowChunkWordCount(1234, 0.5)).toBe(617);
    expect(resolveWorkflowChunkWordCount(20000, 0.5)).toBe(10000);
  });

  it("limits subparts per part and reroutes extra subpart expansions to the parent part", async () => {
    const stages: Array<{ stage: string; data?: Record<string, unknown> }> = [];
    const sourceText = makeWords("mot", 1000);
    const expansionReview = makeWords("detail", 180);

    const generateText = vi.fn(async ({ responseMode, userPrompt }: { responseMode: string; userPrompt: string }) => {
      if (responseMode === "json" && userPrompt.includes("PLAN COURANT:")) {
        return JSON.stringify({
          needs_more: true,
          summary: "Ajouter une sous-partie supplementaire.",
          targets: [
            {
              mode: "new_subpart",
              partIndex: 1,
              subpartIndex: 5,
              heading: "Sous-partie 5",
              focus: "Completer la partie avec une nouvelle sous-partie.",
              rationale: "La transcription contient encore de la matiere utile.",
              priority: 1,
            },
          ],
        });
      }

      if (responseMode === "json" && userPrompt.includes("COMPTE RENDU:")) {
        return JSON.stringify({
          title: "Titre final",
          subtitle: "Sous-titre final",
          key_points: ["Point 1"],
          action_items: [],
          caveats: [],
        });
      }

      if (responseMode === "json" && userPrompt.includes("TRANSCRIPTION COMPLETE:")) {
        return JSON.stringify({
          format: "CRI",
          title: "Plan de test",
          parts: [
            {
              heading: "Partie 1",
              focus: "Focus principal de la partie.",
              subparts: [
                { heading: "Sous-partie 1", focus: "Focus 1" },
                { heading: "Sous-partie 2", focus: "Focus 2" },
                { heading: "Sous-partie 3", focus: "Focus 3" },
                { heading: "Sous-partie 4", focus: "Focus 4" },
                { heading: "Sous-partie 5", focus: "Focus 5" },
              ],
            },
          ],
        });
      }

      if (responseMode === "text" && userPrompt.includes("Brouillon a relire")) {
        return userPrompt.includes("Passage d'agrandissement: 1.") ? expansionReview : "Brouillon initial.";
      }

      if (responseMode === "text" && userPrompt.includes("Phase: extraction")) {
        return "extrait";
      }

      throw new Error(`Unexpected prompt: ${responseMode} ${userPrompt.slice(0, 120)}`);
    });

    const result = await generateCloudMultiPassReport({
      format: "CRI",
      modelId: "test-model",
      sourceText,
      temperature: 0.2,
      maxTokens: 8192,
      detailLevel: "exhaustive",
      chunkRatio: 0.5,
      maxSubpartsPerPart: 4,
      workflowTextMaxTokens: 2048,
      generateText,
      emitStage: (stage, data) => {
        stages.push({ stage, data: data as Record<string, unknown> | undefined });
      },
    });

    const initialPartExtractStart = stages.find((entry) => entry.stage === "workflow_part_extract_start");
    expect(initialPartExtractStart?.data).toMatchObject({
      subpartCount: 4,
    });

    const expansionTargetStarts = stages.filter((entry) => entry.stage === "workflow_expansion_target_start");
    expect(expansionTargetStarts).toHaveLength(1);
    expect(expansionTargetStarts[0]?.data).toMatchObject({
      mode: "expand_part",
      reroutedFromSubpart: true,
    });

    const createdSubpartStructures = stages.filter(
      (entry) =>
        entry.stage === "workflow_expansion_structure_created" &&
        entry.data?.structureKind === "subpart"
    );
    expect(createdSubpartStructures).toHaveLength(0);

    const textCallMaxTokens = generateText.mock.calls
      .filter(([call]) => call.responseMode === "text")
      .map(([call]) => call.maxTokens);
    expect(textCallMaxTokens.length).toBeGreaterThan(0);
    expect(textCallMaxTokens.every((value) => value === 2048)).toBe(true);

    expect(result.pipelinePasses).toBe(2);
    expect(result.report.sections).toHaveLength(1);
    expect(result.report.subtitle).toBe("Sous-titre final");
  });
});
