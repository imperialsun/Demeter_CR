/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect } from 'vitest';
import { decodeFileFully, decodeFileProgressively } from './audio';
import { mockAudioContext, mockDocumentAudio, mockMediaRecorder } from '@/test/audioMocks';

describe('decodeFileFully (with mocks)', () => {
  it('decodes a file and returns pcm and metadata', async () => {
    // fake audio buffer
    const fakeBuffer = {
      sampleRate: 16000,
      length: 16000,
      duration: 1,
      numberOfChannels: 1,
      getChannelData: (_: number) => new Float32Array(16000).fill(0.1),
    } as unknown as AudioBuffer;

    const restore = mockAudioContext(fakeBuffer);
    // polyfill a simple File-like object with arrayBuffer() since node's File may not implement it
    const fileLike = {
      name: 'test.wav',
      size: 0,
      type: 'audio/wav',
      lastModified: 0,
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    } as unknown as File;
    try {
      const result = await decodeFileFully(fileLike, undefined, 16000);
      expect(result.sampleRate).toBe(16000);
      expect(result.pcm.length).toBeGreaterThan(0);
      expect(result.metadata.durationSec).toBeCloseTo(1, 2);
    } finally {
      restore();
    }
  });
});

describe('decodeFileProgressively (with mocks)', () => {
  it('processes at least one chunk using MediaRecorder/requestData flow', async () => {
    // set up mocks: AudioContext decodeAudioData will return fake buffer
    const fakeBuffer = {
      sampleRate: 16000,
      length: 16000,
      duration: 1,
      numberOfChannels: 1,
      getChannelData: (_: number) => new Float32Array(16000).fill(0.1),
    } as unknown as AudioBuffer;

    const restoreAudioCtx = mockAudioContext(fakeBuffer);
    const restoreDocAudio = mockDocumentAudio({ duration: 1, streamTracks: 1 });
    const restoreMedia = mockMediaRecorder();

    // polyfill URL.createObjectURL used by decodeFileProgressively
    const origCreate = (URL as any).createObjectURL;
    const origRevoke = (URL as any).revokeObjectURL;
    (URL as any).createObjectURL = (_: any) => 'blob://test';
    (URL as any).revokeObjectURL = (_: any) => {};

    const fileLike = {
      name: 'test.webm',
      size: 0,
      type: 'audio/webm',
      lastModified: 0,
    } as unknown as File;

    const chunks: any[] = [];
    const chunkPlan = [{ start: 0, end: 1 }];

    try {
      const meta = await decodeFileProgressively(fileLike, {
        chunkPlan: chunkPlan as any,
        targetSampleRate: 16000,
        onChunk: async (c: any) => {
          chunks.push(c);
        },
      } as any);

      expect(meta.durationSec).toBeCloseTo(1, 2);
      // allow the mock recorder to produce a chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    } finally {
      restoreAudioCtx();
      restoreDocAudio();
      restoreMedia();
      (URL as any).createObjectURL = origCreate;
      (URL as any).revokeObjectURL = origRevoke;
    }
  }, 10_000);
});
