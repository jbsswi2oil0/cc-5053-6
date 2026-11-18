export type MaterialId = 'impulse' | 'steady' | 'transient';

export const MATERIAL_LABELS: Record<MaterialId, string> = {
  impulse: '脉冲 IMPULSE',
  steady: '稳定音 STEADY',
  transient: '短瞬态 TRANSIENT',
};

function finish(buffer: Float32Array, fadeSeconds: number, sampleRate: number): Float32Array {
  const fade = Math.max(2, Math.min(Math.floor(fadeSeconds * sampleRate), (buffer.length / 2) | 0));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    buffer[i] *= g;
    buffer[buffer.length - 1 - i] *= g;
  }
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]));
  if (peak > 0.92) {
    const s = 0.92 / peak;
    for (let i = 0; i < buffer.length; i++) buffer[i] *= s;
  }
  return buffer;
}

function unit(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMaterial(id: MaterialId, sampleRate: number): Float32Array {
  if (id === 'impulse') {
    const length = Math.floor(1.8 * sampleRate);
    const out = new Float32Array(length);
    const rnd = unit(0x1a2b3c);
    let t = Math.floor(0.06 * sampleRate);
    while (t < length - 1) {
      const amp = 0.5 + 0.4 * rnd();
      const clickLen = Math.floor(0.007 * sampleRate);
      const freq = 1400 + 2200 * rnd();
      const attack = Math.max(2, Math.floor(0.0009 * sampleRate));
      for (let i = 0; i < clickLen && t + i < length; i++) {
        const x = i / clickLen;
        const atk = Math.min(1, i / attack);
        const env = atk * Math.exp(-x * 9) * (1 - x);
        out[t + i] += amp * env * (0.75 * Math.sin((2 * Math.PI * freq * i) / sampleRate) + 0.25 * (rnd() * 2 - 1));
      }
      t += Math.floor((0.05 + 0.055 * rnd()) * sampleRate);
    }
    return finish(out, 0.004, sampleRate);
  }

  if (id === 'steady') {
    const length = Math.floor(2.4 * sampleRate);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const x = i / sampleRate;
      const slow = 0.82 + 0.12 * Math.sin(2 * Math.PI * 0.4 * x);
      out[i] =
        slow *
        (0.42 * Math.sin(2 * Math.PI * 220 * x) +
          0.2 * Math.sin(2 * Math.PI * 331 * x + 0.7) +
          0.09 * Math.sin(2 * Math.PI * 660 * x + 1.6));
    }
    return finish(out, 0.01, sampleRate);
  }

  const length = Math.floor(2.2 * sampleRate);
  const out = new Float32Array(length);
  const rnd = unit(0x77aa22);
  for (let i = 0; i < length; i++) {
    const x = i / sampleRate;
    out[i] = 0.05 * Math.sin(2 * Math.PI * 110 * x) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * x));
  }
  let t = Math.floor(0.18 * sampleRate);
  let k = 0;
  while (t < length - 1) {
    const burst = Math.floor(0.09 * sampleRate);
    const freq = 520 + 380 * ((k * 7) % 5);
    const attack = Math.max(2, Math.floor(0.0008 * sampleRate));
    for (let i = 0; i < burst && t + i < length; i++) {
      const x = i / burst;
      const atk = Math.min(1, i / attack);
      const env = atk * Math.exp(-x * 14) * (1 - x);
      out[t + i] += env * (0.65 * Math.sin((2 * Math.PI * freq * i) / sampleRate) + 0.22 * (rnd() * 2 - 1) * Math.exp(-x * 30));
    }
    t += Math.floor((0.26 + 0.035 * ((k * 13) % 7)) * sampleRate);
    k++;
  }
  return finish(out, 0.005, sampleRate);
}

export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const mono = new Float32Array(length);
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / n;
  }
  return mono;
}

export function decodeAudioFile(arrayBuffer: ArrayBuffer, ctx: BaseAudioContext): Promise<Float32Array> {
  return ctx.decodeAudioData(arrayBuffer.slice(0)).then((buffer) => {
    const mono = downmixToMono(buffer);
    return Promise.resolve(mono);
  });
}
