/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SegmentationStatusPanel } from "@/components/status/SegmentationStatusPanel";
import { useAsrStore } from "@/store/asr-store";

describe("SegmentationStatusPanel", () => {
  it("renders idle status by default", () => {
    useAsrStore.setState({
      segmentationStatus: "idle",
      segmentationProgress: 0,
    } as any);

    render(<SegmentationStatusPanel />);

    expect(screen.getByText("Pré-segmentation")).toBeInTheDocument();
    expect(screen.getByText("Inactif")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("renders running and done labels", () => {
    useAsrStore.setState({
      segmentationStatus: "segmenting",
      segmentationProgress: 0.42,
    } as any);

    const { rerender } = render(<SegmentationStatusPanel />);
    expect(screen.getByText("Découpage…")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();

    useAsrStore.setState({
      segmentationStatus: "done",
      segmentationProgress: 1,
    } as any);
    rerender(<SegmentationStatusPanel />);

    expect(screen.getByText("Terminée")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("falls back to idle label for unknown status", () => {
    useAsrStore.setState({
      segmentationStatus: "mystery",
      segmentationProgress: 0.33,
    } as any);

    render(<SegmentationStatusPanel />);

    expect(screen.getByText("Inactif")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
  });
});
