/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// Utilities to mock AudioContext, OfflineAudioContext, Audio element and MediaRecorder for tests
// Ensure Blob.arrayBuffer exists in this environment (polyfill if missing)
if (typeof (Blob.prototype as any).arrayBuffer !== 'function') {
  (Blob.prototype as any).arrayBuffer = async function () {
    // Fallback: create an ArrayBuffer of the blob's size when text() is not available
    const size = typeof (this as any).size === 'number' ? (this as any).size : 0;
    return new Uint8Array(size).buffer;
  };
}

export function mockAudioContext(fakeAudioBuffer: Partial<AudioBuffer> & { getChannelData: (i: number) => Float32Array }) {
  const Original = (globalThis as any).AudioContext;
  class MockAudioContext {
    sampleRate: number;
    constructor() {
      this.sampleRate = (fakeAudioBuffer.sampleRate as number) || 16000;
    }
    async decodeAudioData(_buf: ArrayBuffer) {
      return fakeAudioBuffer as unknown as AudioBuffer;
    }
    async close() {
      return;
    }
  }
  (globalThis as any).AudioContext = MockAudioContext;
  return () => {
    (globalThis as any).AudioContext = Original;
  };
}

export function mockOfflineAudioContext(renderedLength = 0) {
  const Original = (globalThis as any).OfflineAudioContext;
  class MockOfflineAudioContext {
    constructor(_channels: number, _frameCount: number, _sampleRate: number) {}
    createBuffer(_channels: number, length: number, sampleRate: number) {
      // return a minimal buffer-like object
      return {
        length,
        sampleRate,
        numberOfChannels: 1,
        copyToChannel: (_arr: Float32Array, _ch: number) => {},

      } as unknown as AudioBuffer;
    }
    audioWorklet = { addModule: async (_: string) => {} };
    createBufferSource() {
      return { buffer: null, connect: () => {}, start: () => {} } as any;
    }
    get destination() {
      return {} as any;
    }
    async startRendering() {
      // return a buffer-like object that allows copyFromChannel
      const length = renderedLength || 128;
      const data = new Float32Array(length).fill(0.1);
      return {
        length,
        copyFromChannel: (out: Float32Array, _ch: number) => {
          out.set(data.subarray(0, out.length));
        },
      } as unknown as AudioBuffer;
    }
  }
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  return () => {
    (globalThis as any).OfflineAudioContext = Original;
  };
}

export function createFakeBlobWithArrayBuffer(size = 1000) {
  // use a real Blob so arrayBuffer() exists on all environments
  return new Blob([new Uint8Array(size)], { type: 'audio/webm' });
}

export function mockDocumentAudio({ duration = 1, streamTracks = 1 } = {}) {
  const origCreate = document.createElement.bind(document);
  const origAudio = (globalThis as any).Audio;

  function makeAudio() {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    let currentTime = 0;
    return {
      preload: 'auto',
      muted: true,
      crossOrigin: 'anonymous',
      playbackRate: 1,
      duration,
      get currentTime() {
        return currentTime;
      },
      set currentTime(value: number) {
        currentTime = value;
        const seekListeners = listeners.seeked || [];
        setTimeout(() => {
          seekListeners.forEach((fn) => fn());
        }, 0);
      },
      readyState: 4,
      addEventListener(type: string, cb: (...args: any[]) => void, _opts?: any) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(cb);
        // trigger loadedmetadata immediately for tests
        if (type === 'loadedmetadata') {
          setTimeout(() => cb(), 0);
        }
        // auto-trigger ended shortly after start to allow progressive decode to finish in tests
        if (type === 'ended') {
          setTimeout(() => {
            listeners[type]!.forEach((fn) => fn());
          }, 20);
        }
      },
      removeEventListener(type: string, cb: (...args: any[]) => void) {
        if (!listeners[type]) return;
        listeners[type] = listeners[type]!.filter((fn) => fn !== cb);
      },
      removeAttribute() {},
      play: async () => Promise.resolve(),
      captureStream: () => ({ getAudioTracks: () => new Array(streamTracks).fill({}) }),
      pause() {},
      load() {},
      setAttribute() {},
    } as unknown as HTMLAudioElement;
  }

  (document as any).createElement = (tag: string) => {
    if (tag === 'audio') return makeAudio();
    return origCreate(tag);
  };
  (globalThis as any).Audio = function (_src?: string) {
    return makeAudio();
  } as any;

  return () => {
    (document as any).createElement = origCreate;
    (globalThis as any).Audio = origAudio;
  };
}

export function mockMediaRecorder() {
  // A minimal MediaRecorder mock that supports start(), requestData(), stop(), state and dataavailable
  const Original = (globalThis as any).MediaRecorder;
  class MockMediaRecorder extends EventTarget {
    state: 'inactive' | 'recording' | 'paused' = 'inactive';
    mimeType = 'audio/webm';
    constructor(_stream: any, _opts?: any) {
      super();
    }
    start(_timeslice?: number) {
      this.state = 'recording';
      return;
    }
    stop() {
      this.state = 'inactive';
      const evt = new Event('stop');
      this.dispatchEvent(evt);
    }
    requestData() {
      // dispatch a dataavailable with a fake blob
      const blob = createFakeBlobWithArrayBuffer(256);
      const evt: any = new Event('dataavailable');
      evt.data = blob;
      // schedule on next tick to mimic async behavior
      setTimeout(() => this.dispatchEvent(evt), 0);
    }
  }
  (globalThis as any).MediaRecorder = MockMediaRecorder;
  return () => {
    (globalThis as any).MediaRecorder = Original;
  };
}
