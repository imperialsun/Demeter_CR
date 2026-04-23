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
    expect(screen.getByLabelText("Mode détaillé", { selector: "button#settings-llm-report-generation-mode" })).toHaveTextContent("Monopasse");
    expect(screen.getByLabelText("Taille cible des chunks (%)")).toHaveValue(50);
    expect(screen.getByLabelText("Sous-parties max par partie")).toHaveValue(4);
    expect(screen.getByLabelText("Plafond max tokens mono-pass")).toHaveValue(16384);
    expect(screen.getByLabelText("Plafond max tokens multi-pass")).toHaveValue(8192);
  });

  it("updates the detailed mode and token ceilings independently", async () => {
    render(<LlmCloudSettingsTab showMistral={false} showDemeter={false} />);

    fireEvent.click(screen.getByLabelText("Mode détaillé", { selector: "button#settings-llm-report-generation-mode" }));
    fireEvent.click(await screen.findByText("Multipasse"));
    fireEvent.change(screen.getByLabelText("Taille cible des chunks (%)"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByLabelText("Sous-parties max par partie"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Plafond max tokens mono-pass"), {
      target: { value: "8192" },
    });
    fireEvent.change(screen.getByLabelText("Plafond max tokens multi-pass"), {
      target: { value: "32768" },
    });

    expect(useAsrStore.getState().llmApiReportGenerationMode).toBe("multi_pass");
    expect(useAsrStore.getState().llmApiReportChunkRatio).toBe(0.6);
    expect(useAsrStore.getState().llmApiReportMaxSubpartsPerPart).toBe(2);
    expect(useAsrStore.getState().llmApiReportMonoPassMaxTokens).toBe(8192);
    expect(useAsrStore.getState().llmApiReportWorkflowTextMaxTokens).toBe(32768);
  });
});
