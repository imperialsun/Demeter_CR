/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { useAsrStore } from "@/store/asr-store";
import { LlmCloudSettingsTab } from "@/components/settings/LlmCloudSettingsTab";

describe("LlmCloudSettingsTab", () => {
  beforeEach(() => {
    useAsrStore.setState({
      llmApiProvider: "huggingface",
      hfApiToken: "",
      llmApiHfModelId: "openai/gpt-oss-20b",
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 131072,
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralTemperature: 0.2,
      llmApiMistralMaxTokens: 8192,
      llmApiReportDetailLevels: {
        CRI: "standard",
        CRO: "standard",
        CRS: "standard",
        CRN: "standard",
      },
      llmApiReportGenerationMode: "mono_pass",
      llmApiReportChunkRatio: 0.5,
      llmApiReportMaxSubpartsPerPart: 4,
      llmApiReportMonoPassMaxTokens: 16384,
      llmApiReportWorkflowTextMaxTokens: 8192,
      mistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
    } as any);
  });

  it("renders workflow controls with the default values", () => {
    render(<LlmCloudSettingsTab showMistral={false} showDemeter={false} />);

    expect(screen.getByRole("heading", { name: "Workflow de generation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Plafond max tokens mono-pass")).toHaveValue(16384);
  });

  it("updates the mono-pass token ceiling", () => {
    render(<LlmCloudSettingsTab showMistral={false} showDemeter={false} />);

    fireEvent.change(screen.getByLabelText("Plafond max tokens mono-pass"), {
      target: { value: "8192" },
    });

    expect(useAsrStore.getState().llmApiReportMonoPassMaxTokens).toBe(8192);
  });
});
