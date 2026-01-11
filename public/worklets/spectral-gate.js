/*
 * Spectral gating AudioWorkletProcessor
 * - FFT size: 1024
 * - Hop size: 256
 * - Window: Hann
 * - Applies soft-knee attenuation based on a provided noise profile
 */

class SpectralGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.fftSize = opts.fftSize || 1024;
    this.hopSize = opts.hopSize || 256;
    this.binCount = this.fftSize / 2 + 1;
    this.window = buildHann(this.fftSize);
    this.noiseProfile = opts.noiseProfile ? new Float32Array(opts.noiseProfile) : new Float32Array(this.binCount);
    this.noiseFloorDb = typeof opts.noiseFloorDb === "number" ? opts.noiseFloorDb : -25;
    this.reductionDb = typeof opts.reductionDb === "number" ? opts.reductionDb : 12;
    this.smoothing = clamp(typeof opts.smoothing === "number" ? opts.smoothing : 0.8, 0, 0.999);
    this.kneeDb = 6;

    this.inputQueue = [];
    this.analysisTail = new Float32Array(this.fftSize - this.hopSize);
    this.overlapBuffer = new Float32Array(this.fftSize);
    this.outputQueue = [];
    this.prevGains = new Float32Array(this.binCount).fill(1);

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "updateParams") {
        if (typeof data.noiseFloorDb === "number") this.noiseFloorDb = data.noiseFloorDb;
        if (typeof data.reductionDb === "number") this.reductionDb = data.reductionDb;
        if (typeof data.smoothing === "number") this.smoothing = clamp(data.smoothing, 0, 0.999);
      }
      if (data.type === "updateNoiseProfile" && data.noiseProfile) {
        this.noiseProfile = new Float32Array(data.noiseProfile);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    // Enqueue input samples
    for (let i = 0; i < input.length; i++) {
      this.inputQueue.push(input[i]);
    }

    // Produce frames when enough samples are buffered
    while (this.inputQueue.length >= this.hopSize) {
      const frame = new Float32Array(this.fftSize);
      frame.set(this.analysisTail, 0);
      for (let i = 0; i < this.hopSize; i++) {
        frame[this.analysisTail.length + i] = this.inputQueue[i];
      }
      this.inputQueue = this.inputQueue.slice(this.hopSize);
      this.analysisTail = frame.slice(this.hopSize);

      const processedFrame = this.processFrame(frame);
      this.addToOutput(processedFrame);
    }

    for (let i = 0; i < output.length; i++) {
      output[i] = this.outputQueue.length ? this.outputQueue.shift() : 0;
    }

    return true;
  }

  processFrame(frame) {
    const re = new Float32Array(this.fftSize);
    const im = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      re[i] = frame[i] * this.window[i];
      im[i] = 0;
    }

    fftRadix2(re, im);
    this.applyGate(re, im);
    ifftRadix2(re, im);

    for (let i = 0; i < this.fftSize; i++) {
      re[i] *= this.window[i];
    }
    return re;
  }

  applyGate(re, im) {
    for (let bin = 0; bin < this.binCount; bin++) {
      const mag = Math.hypot(re[bin], im[bin]);
      const noise = this.noiseProfile[bin] || 1e-6;
      const noiseDb = linearToDb(noise);
      const magDb = linearToDb(mag + 1e-9);
      const thresholdDb = noiseDb + this.noiseFloorDb;
      const delta = thresholdDb - magDb;
      let gainDb = 0;
      if (delta > -this.kneeDb) {
        const t = Math.min(1, Math.max(0, (delta + this.kneeDb) / this.kneeDb));
        gainDb = -this.reductionDb * t;
      }
      const targetGain = dbToLinear(gainDb);
      const smoothed = this.smoothing * this.prevGains[bin] + (1 - this.smoothing) * targetGain;
      this.prevGains[bin] = smoothed;
      re[bin] *= smoothed;
      im[bin] *= smoothed;
      if (bin > 0 && bin < this.binCount - 1) {
        const mirror = this.fftSize - bin;
        re[mirror] = re[bin];
        im[mirror] = -im[bin];
      }
    }
  }

  addToOutput(frame) {
    for (let i = 0; i < this.fftSize; i++) {
      this.overlapBuffer[i] += frame[i];
    }
    const chunk = this.overlapBuffer.slice(0, this.hopSize);
    this.outputQueue.push(...chunk);
    this.overlapBuffer.copyWithin(0, this.hopSize);
    this.overlapBuffer.fill(0, this.fftSize - this.hopSize);
  }
}

function buildHann(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function linearToDb(value) {
  return 20 * Math.log10(Math.max(1e-12, value));
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function fftRadix2(re, im) {
  const n = re.length;
  if (n <= 1) return;
  let target = 0;
  for (let position = 0; position < n; position++) {
    if (target > position) {
      const tr = re[target];
      const ti = im[target];
      re[target] = re[position];
      im[target] = im[position];
      re[position] = tr;
      im[position] = ti;
    }
    let mask = n >> 1;
    while (target & mask) {
      target &= ~mask;
      mask >>= 1;
    }
    target |= mask;
  }
  for (let step = 2; step <= n; step <<= 1) {
    const jump = step << 1;
    const delta = Math.PI * 2 / step;
    const sine = Math.sin(delta / 2);
    const multiplier = -2 * sine * sine;
    const phaseShiftStep = Math.sin(delta);
    for (let group = 0; group < n; group += step) {
      let phaseShiftRe = 1;
      let phaseShiftIm = 0;
      for (let pair = 0; pair < step / 2; pair++) {
        const match = group + pair + step / 2;
        const gr = re[group + pair];
        const gi = im[group + pair];
        const hr = re[match];
        const hi = im[match];

        const tr = phaseShiftRe * hr - phaseShiftIm * hi;
        const ti = phaseShiftRe * hi + phaseShiftIm * hr;
        re[group + pair] = gr + tr;
        im[group + pair] = gi + ti;
        re[match] = gr - tr;
        im[match] = gi - ti;

        const tmpRe = phaseShiftRe;
        phaseShiftRe += phaseShiftRe * multiplier + phaseShiftIm * phaseShiftStep;
        phaseShiftIm += phaseShiftIm * multiplier - tmpRe * phaseShiftStep;
      }
    }
  }
}

function ifftRadix2(re, im) {
  for (let i = 0; i < re.length; i++) {
    im[i] = -im[i];
  }
  fftRadix2(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] = re[i] / n;
    im[i] = -im[i] / n;
  }
}

registerProcessor("spectral-gate-processor", SpectralGateProcessor);
