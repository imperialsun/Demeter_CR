/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect } from 'vitest';
import { decodeCompressedBlobToPcm, decodeFileFully, decodeFileSegmentToPcm } from './audio';
import { mockAudioContext, mockDocumentAudio, mockMediaRecorder, mockOfflineAudioContext } from '../test/audioMocks';

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

describe('decodeFileSegmentToPcm (with mocks)', () => {
  it('decodes a single segment to pcm', async () => {
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

    try {
      const result = await decodeFileSegmentToPcm(
        fileLike,
        { index: 0, startSec: 0, endSec: 1 },
        { targetSampleRate: 16000 }
      );
      expect(result.pcm.length).toBeGreaterThan(0);
      expect(result.sampleRate).toBe(16000);
    } finally {
      restoreAudioCtx();
      restoreDocAudio();
      restoreMedia();
      (URL as any).createObjectURL = origCreate;
      (URL as any).revokeObjectURL = origRevoke;
    }
  }, 10_000);
});

describe('decodeCompressedBlobToPcm (with mocks)', () => {
  it('decodes a compressed blob to pcm', async () => {
    const fakeBuffer = {
      sampleRate: 16000,
      length: 16000,
      duration: 1,
      numberOfChannels: 1,
      getChannelData: (_: number) => new Float32Array(16000).fill(0.1),
    } as unknown as AudioBuffer;

    const restoreAudioCtx = mockAudioContext(fakeBuffer);
    const restoreOffline = mockOfflineAudioContext(16000);
    const blob = new Blob([new Uint8Array(8)], { type: 'audio/webm' });

    try {
      const result = await decodeCompressedBlobToPcm(blob, undefined, 16000);
      expect(result.sampleRate).toBe(16000);
      expect(result.pcm.length).toBeGreaterThan(0);
    } finally {
      restoreAudioCtx();
      restoreOffline();
    }
  });
});
