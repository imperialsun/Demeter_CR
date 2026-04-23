import { describe, expect, it } from "vitest";
import { resolveCloudRunStageDescriptor } from "@/lib/llm/reportTrace";

describe("reportTrace", () => {
  it("keeps mono-pass format stages unlabeled with workflow passes", () => {
    const descriptor = resolveCloudRunStageDescriptor(
      "format_generation_start",
      {},
      {
        provider: "huggingface",
        modelId: "openai/gpt-oss-20b",
        sourceMode: "transcription",
        format: "CRI",
        detailLevel: "verbose",
        generationMode: "mono_pass",
        sequenceIndex: 1,
        sequenceTotal: 3,
      }
    );

    expect(descriptor.telemetryData.generationMode).toBe("mono_pass");
    expect(descriptor.globalPassTotal).toBe(1);
    expect(descriptor.stageLabel).toBe("Compte rendu détaillé · démarrage");
  });

  it("labels workflow stages as multi-pass runs", () => {
    const descriptor = resolveCloudRunStageDescriptor(
      "workflow_start",
      {},
      {
        provider: "huggingface",
        modelId: "openai/gpt-oss-20b",
        sourceMode: "transcription",
        format: "CRI",
        detailLevel: "verbose",
        generationMode: "multi_pass",
        sequenceIndex: 1,
        sequenceTotal: 3,
      }
    );

    expect(descriptor.telemetryData.generationMode).toBe("multi_pass");
    expect(descriptor.globalPassTotal).toBe(6);
    expect(descriptor.stageLabel).toContain("Passe 1/6");
    expect(descriptor.stageLabel).toContain("Planification");
  });
});
