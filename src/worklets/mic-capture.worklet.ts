// TypeScript in this repo doesn't include the AudioWorklet lib types by default.
// Provide minimal declarations so `tsc -b` succeeds.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

const BLOCK_SIZE = 4096;

type FlushMessage = { type: "flush" };
type ChunkMessage = { type: "chunk"; pcm: Float32Array; rms: number };
type FlushedMessage = { type: "flushed" };

class MicCaptureProcessor extends AudioWorkletProcessor {
  private pending: Float32Array[] = [];
  private pendingSamples = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<FlushMessage>) => {
      if (event.data?.type === "flush") {
        this.flush();
      }
    };
  }

  private flush() {
    if (this.pendingSamples > 0) {
      const merged = new Float32Array(this.pendingSamples);
      let offset = 0;
      for (const chunk of this.pending) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.pending = [];
      this.pendingSamples = 0;
      const rms = this.computeRms(merged);
      const message: ChunkMessage = { type: "chunk", pcm: merged, rms };
      this.port.postMessage(message, [merged.buffer]);
    }
    const flushed: FlushedMessage = { type: "flushed" };
    this.port.postMessage(flushed);
  }

  private computeRms(pcm: Float32Array) {
    if (pcm.length === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const v = pcm[i] ?? 0;
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / pcm.length);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (input && output) {
      output.set(input);
    }

    if (!input) return true;

    const copy = new Float32Array(input.length);
    copy.set(input);
    this.pending.push(copy);
    this.pendingSamples += copy.length;

    while (this.pendingSamples >= BLOCK_SIZE) {
      const out = new Float32Array(BLOCK_SIZE);
      let filled = 0;
      while (filled < BLOCK_SIZE && this.pending.length > 0) {
        const head = this.pending[0]!;
        const take = Math.min(head.length, BLOCK_SIZE - filled);
        out.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) {
          this.pending.shift();
        } else {
          this.pending[0] = head.subarray(take);
        }
      }
      this.pendingSamples -= BLOCK_SIZE;

      const rms = this.computeRms(out);
      const message: ChunkMessage = { type: "chunk", pcm: out, rms };
      this.port.postMessage(message, [out.buffer]);
    }

    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
