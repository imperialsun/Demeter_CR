import { describe, expect, it } from 'vitest';

import {
  createFakeBlobWithArrayBuffer,
  mockAudioContext,
  mockDocumentAudio,
  mockMediaRecorder,
  mockOfflineAudioContext,
} from './audioMocks';

describe('audioMocks helpers', () => {
  it('mockAudioContext overrides decodeAudioData and restores original context', async () => {
    const fakeAudioBuffer = {
      sampleRate: 22050,
      getChannelData: () => new Float32Array([0.1, 0.2, 0.3]),
    };

    const restore = mockAudioContext(fakeAudioBuffer);
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(new ArrayBuffer(8));

    expect(decoded).toBe(fakeAudioBuffer);
    await ctx.close();
    restore();
  });

  it('mockOfflineAudioContext exposes minimal rendering behavior', async () => {
    const restore = mockOfflineAudioContext(64);

    const ctx = new OfflineAudioContext(1, 64, 16000) as unknown as {
      createBuffer: (channels: number, length: number, sampleRate: number) => { length: number };
      createBufferSource: () => { start: () => void; connect: () => void };
      startRendering: () => Promise<{ copyFromChannel: (out: Float32Array, channel: number) => void }>;
    };

    const buffer = ctx.createBuffer(1, 32, 16000);
    expect(buffer.length).toBe(32);

    const source = ctx.createBufferSource();
    source.connect();
    source.start();

    const rendered = await ctx.startRendering();
    const out = new Float32Array(4);
    rendered.copyFromChannel(out, 0);
    expect(out[0]).toBeCloseTo(0.1, 4);

    restore();
  });

  it('createFakeBlobWithArrayBuffer creates an audio blob with expected size', async () => {
    const blob = createFakeBlobWithArrayBuffer(128);
    const bytes = await blob.arrayBuffer();

    expect(blob.type).toBe('audio/webm');
    expect(bytes.byteLength).toBe(128);
  });

  it('mockDocumentAudio creates audio elements with simulated events and stream tracks', async () => {
    const restore = mockDocumentAudio({ duration: 3, streamTracks: 2 });

    const audio = document.createElement('audio') as unknown as HTMLAudioElement & {
      captureStream: () => { getAudioTracks: () => Array<unknown> };
    };

    await new Promise<void>((resolve) => {
      audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });

    await new Promise<void>((resolve) => {
      audio.addEventListener('seeked', () => resolve(), { once: true });
      audio.currentTime = 1;
    });

    const stream = audio.captureStream();
    expect(stream.getAudioTracks()).toHaveLength(2);

    await new Promise<void>((resolve) => {
      audio.addEventListener('ended', () => resolve(), { once: true });
    });

    restore();
  });

  it('mockMediaRecorder dispatches dataavailable and stop events', async () => {
    const restore = mockMediaRecorder();

    const recorder = new MediaRecorder({} as MediaStream, {} as MediaRecorderOptions);
    const receivedChunks: Blob[] = [];
    let stopped = false;

    recorder.addEventListener('dataavailable', (event) => {
      const data = (event as Event & { data?: Blob }).data;
      if (data) {
        receivedChunks.push(data);
      }
    });
    recorder.addEventListener('stop', () => {
      stopped = true;
    });

    recorder.start();
    recorder.requestData();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(receivedChunks).toHaveLength(1);

    recorder.stop();
    expect(stopped).toBe(true);

    restore();
  });
});
