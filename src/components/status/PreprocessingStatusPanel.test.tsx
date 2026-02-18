/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PreprocessingStatusPanel } from "@/components/status/PreprocessingStatusPanel";
import { useAsrStore } from "@/store/asr-store";

describe("PreprocessingStatusPanel", () => {
  it("renders status and progress", () => {
    useAsrStore.setState({
      preprocessingStatus: "processing",
      preprocessingProgress: 0.37,
      denoiseNoiseFloorDb: -28,
      denoiseReductionDb: 12,
      denoiseSmoothing: 0.8,
      setDenoiseParams: () => undefined,
    } as any);

    render(<PreprocessingStatusPanel />);

    expect(screen.getByText("Préprocessing")).toBeInTheDocument();
    expect(screen.getByText("Prétraitement")).toBeInTheDocument();
    expect(screen.getByText("37%")).toBeInTheDocument();
  });

  it("expands and collapses manual details with disabled sliders", () => {
    useAsrStore.setState({
      preprocessingStatus: "calibrating",
      preprocessingProgress: 0.1,
      denoiseNoiseFloorDb: -28,
      denoiseReductionDb: 12,
      denoiseSmoothing: 0.8,
      setDenoiseParams: () => undefined,
    } as any);

    render(<PreprocessingStatusPanel />);

    expect(screen.queryByLabelText("Noise floor (dB)", { selector: "input#pre-noise-floor" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /détails/i }));

    const noiseFloor = screen.getByLabelText("Noise floor (dB)", { selector: "input#pre-noise-floor" });
    const reduction = screen.getByLabelText("Réduction (dB)", { selector: "input#pre-reduction-db" });
    const smoothing = screen.getByLabelText("Lissage", { selector: "input#pre-smoothing" });
    expect(noiseFloor).toBeDisabled();
    expect(reduction).toBeDisabled();
    expect(smoothing).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /détails/i }));
    expect(screen.queryByLabelText("Noise floor (dB)", { selector: "input#pre-noise-floor" })).toBeNull();
  });
});
