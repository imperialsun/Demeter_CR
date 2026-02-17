/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeProvider } from "@/components/theme-provider";
import { useAsrStore } from "@/store/asr-store";
import { LlmLocalSettingsTab } from "@/components/settings/LlmLocalSettingsTab";
import { createDefaultLocalModelSettingsByProfile } from "@/lib/llm/localModelCatalog";

describe("LlmLocalSettingsTab", () => {
  beforeEach(() => {
    const elementProto = HTMLElement.prototype as unknown as {
      hasPointerCapture?: (pointerId: number) => boolean;
      setPointerCapture?: (pointerId: number) => void;
      releasePointerCapture?: (pointerId: number) => void;
    };
    elementProto.hasPointerCapture ??= () => false;
    elementProto.setPointerCapture ??= () => {};
    elementProto.releasePointerCapture ??= () => {};

    const defaults = createDefaultLocalModelSettingsByProfile();
    useAsrStore.setState({
      llmLocalModelProfile: "qwen_1_7b",
      llmLocalModelId: defaults.qwen_1_7b.modelId,
      llmLocalTemperature: defaults.qwen_1_7b.temperature,
      llmLocalMaxTokens: defaults.qwen_1_7b.maxTokens,
      llmLocalDtypeWebgpu: defaults.qwen_1_7b.dtypeWebgpu,
      llmLocalDtypeWasm: defaults.qwen_1_7b.dtypeWasm,
      llmLocalSettingsByProfile: defaults,
      llmLocalForceSingleThread: false,
    } as any);
  });

  function renderTab() {
    return render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <LlmLocalSettingsTab />
      </ThemeProvider>
    );
  }

  it("renders qwen and ministral cards", () => {
    renderTab();

    expect(screen.getByRole("heading", { name: "Qwen 3 1.7B" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ministral 3 3B Instruct" })).toBeInTheDocument();
  });

  it("updates qwen settings without mutating ministral settings", () => {
    renderTab();

    fireEvent.change(screen.getByLabelText("Temperature", { selector: "input#settings-llm-local-qwen_1_7b-temperature" }), {
      target: { value: "0.6" },
    });

    const state = useAsrStore.getState();
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.temperature).toBe(0.6);
    expect(state.llmLocalSettingsByProfile.ministral_3_3b.temperature).toBe(
      createDefaultLocalModelSettingsByProfile().ministral_3_3b.temperature
    );
  });

  it("toggles appendNoThinkDirective per model", async () => {
    renderTab();

    const toggle = screen.getByRole("switch", { name: "append-no-think-qwen_1_7b" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);

    expect(useAsrStore.getState().llmLocalSettingsByProfile.qwen_1_7b.appendNoThinkDirective).toBe(false);
  });

  it("keeps WASM dtype control enabled for ministral profile", () => {
    renderTab();

    expect(
      screen.getByLabelText("Dtype WASM", { selector: "button#settings-llm-local-ministral_3_3b-dtype-wasm" })
    ).not.toBeDisabled();
    expect(screen.queryByText("WASM desactive: ce profil exige WebGPU.")).not.toBeInTheDocument();
  });

  it("toggles llm local multithread switch", async () => {
    renderTab();

    const toggle = screen.getByRole("switch", { name: "llm-local-multithread-switch" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);
    expect(useAsrStore.getState().llmLocalForceSingleThread).toBe(true);

    await userEvent.click(toggle);
    expect(useAsrStore.getState().llmLocalForceSingleThread).toBe(false);
  });
});
