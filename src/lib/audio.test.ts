/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect } from 'vitest';
import { mixToMono, extractChunkPcm, resampleMono, probeAudioMetadata, encodeWavBuffer, mixToMono as _mix } from './audio';

// Minimal fake AudioBuffer used for mixToMono
function makeAudioBuffer(channels: number, length: number, valuesPerChannel: number[][]) {
  return {
    numberOfChannels: channels,
    length,
    getChannelData: (i: number) => new Float32Array(valuesPerChannel[i] || new Array(length).fill(0)),
  } as unknown as AudioBuffer;
}

describe('audio helpers', () => {
  it('mixToMono averages channels', () => {
    const buf = makeAudioBuffer(2, 4, [
      [1, 0.5, -0.5, 0],
      [0, 0.5, 0.5, 1],
    ]);
    const mono = mixToMono(buf);
    expect(mono.length).toBe(4);
    // element-wise average
    expect(mono[0]).toBeCloseTo((1 + 0) / 2);
    expect(mono[1]).toBeCloseTo((0.5 + 0.5) / 2);
    expect(mono[2]).toBeCloseTo((-0.5 + 0.5) / 2);
    expect(mono[3]).toBeCloseTo((0 + 1) / 2);
  });

  it('extractChunkPcm slices according to padded boundaries', () => {
    const pcm = new Float32Array(16000 * 2); // 2 seconds at 16k
    for (let i = 0; i < pcm.length; i++) pcm[i] = i / pcm.length;
    const chunk = { paddedStart: 0.5, paddedEnd: 1.5 };
    const slice = extractChunkPcm(pcm, 16000, chunk as any);
    expect(slice.length).toBe(Math.ceil((1.5 - 0.5) * 16000));
  });

  it('resampleMono returns same array when sample rates match', async () => {
    const mono = new Float32Array([0, 0.1, -0.1, 0.5]);
    const out = await resampleMono(mono, 16000, 16000);
    // Implementation returns the original buffer when sample rates match
    expect(out).toBe(mono);
    expect(Array.from(out)).toEqual(Array.from(mono));
  });

  it('probeAudioMetadata returns fallback when document is undefined', async () => {
    // Temporarily remove document to simulate SSR/non-browser
     
    const origDoc = (globalThis as any).document;
    // delete global document to test fallback path
    delete (globalThis as any).document;
    const file = new File([''], 'foo.wav', { type: 'audio/wav', lastModified: 0 });
    const meta = await probeAudioMetadata(file);
    expect(meta.name).toBe('foo.wav');
    expect(meta.durationSec).toBe(0);
    // restore
    (globalThis as any).document = origDoc;
  });

  it('encodeWavBuffer writes a valid wav header', () => {
    const pcm = new Float32Array([0, 1, -1]);
    const buffer = encodeWavBuffer(pcm, 16000);
    const view = new DataView(buffer);
    expect(readString(view, 0, 4)).toBe('RIFF');
    expect(readString(view, 8, 4)).toBe('WAVE');
    expect(readString(view, 12, 4)).toBe('fmt ');
    expect(readString(view, 36, 4)).toBe('data');
    const dataSize = view.getUint32(40, true);
    expect(dataSize).toBe(pcm.length * 2);
  });
});

function readString(view: DataView, offset: number, length: number) {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}
