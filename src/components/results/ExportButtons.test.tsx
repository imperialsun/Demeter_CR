/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportButtons } from './ExportButtons';
import * as exportLib from '@/lib/export';
import { useAsrStore } from '@/store/asr-store';

vi.mock('@/lib/export', async () => ({
  ...(await vi.importActual('@/lib/export')),
  downloadBlob: vi.fn(),
  serializeVtt: vi.fn(() => 'vtt'),
  serializeSrt: vi.fn(() => 'srt'),
  serializeSegmentsJson: vi.fn(() => 'json'),
  serializeTelemetry: vi.fn(() => 'telemetry'),
}));

describe('ExportButtons', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAsrStore.setState({
      showExportVtt: true,
      showExportSrt: true,
      showExportJson: true,
      showExportTelemetry: true,
    } as any);
  });

  it('renders buttons based on store flags and triggers download', () => {
    const downloadSpy = vi.spyOn(exportLib, 'downloadBlob');
    const segments: any[] = [{ index: 0, start: 0, end: 1, text: 'a' }];
    const telemetry = { sessionId: 's1' } as any;

    render(<ExportButtons segments={segments} telemetry={telemetry} />);

    const vtt = screen.getByText('VTT');
    const srt = screen.getByText('SRT');
    const json = screen.getByText('JSON');
    const tele = screen.getByText('Telemetry');

    expect(vtt).toBeTruthy();
    expect(srt).toBeTruthy();
    expect(json).toBeTruthy();
    expect(tele).toBeTruthy();

    fireEvent.click(vtt);
    expect(downloadSpy).toHaveBeenCalled();
    fireEvent.click(srt);
    fireEvent.click(json);
    fireEvent.click(tele);

    expect((exportLib.serializeVtt as any)).toHaveBeenCalledWith(segments);
    expect((exportLib.serializeTelemetry as any)).toHaveBeenCalledWith(telemetry);
  });

  it('disables export buttons when there is no data', () => {
    const segments: any[] = [];
    render(<ExportButtons segments={segments} />);
    // Buttons should exist but be disabled
    const vtt = screen.getByText('VTT').closest('button');
    expect(vtt).toBeDisabled();
  });

  it('respects explicit show flags over store defaults', () => {
    useAsrStore.setState({
      showExportVtt: true,
      showExportSrt: true,
      showExportJson: true,
      showExportTelemetry: true,
    } as any);

    const segments: any[] = [{ index: 0, start: 0, end: 1, text: 'a' }];
    const telemetry = { sessionId: 's1' } as any;
    render(
      <ExportButtons
        segments={segments}
        telemetry={telemetry}
        showVtt={false}
        showJson={false}
        showTelemetry={false}
      />
    );

    expect(screen.queryByText('VTT')).toBeNull();
    expect(screen.queryByText('JSON')).toBeNull();
    expect(screen.queryByText('Telemetry')).toBeNull();
    expect(screen.getByText('SRT')).toBeTruthy();
  });
});
