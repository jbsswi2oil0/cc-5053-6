import { describe, expect, it } from 'vitest';
import { GrainEngine } from '../src/grain/engine';
import { DEFAULT_PARAMS, GrainParams } from '../src/grain/types';
import { generateMaterial } from '../src/grain/materials';

const SR = 48000;

function render(density: number, params: Partial<GrainParams> = {}, seconds = 2) {
  const engine = new GrainEngine(SR);
  engine.setSource(generateMaterial('steady', SR), SR, 'steady');
  engine.setParams({ ...DEFAULT_PARAMS, density, ...params });
  engine.play();
  const total = Math.floor(seconds * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let off = 0; off < total; off += 128) {
    const n = Math.min(128, total - off);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    engine.process(l, r);
    left.set(l, off);
    right.set(r, off);
  }
  return { left, right, engine };
}

function maxSampleStep(x: Float32Array): number {
  let d = 0;
  for (let i = 1; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - x[i - 1]));
  return d;
}

describe('audio quality', () => {
  it('has no large discontinuities between samples (no clicks)', () => {
    for (const density of [6, 30, 120]) {
      const { left } = render(density, { grainDuration: 0.09, durationJitter: 0.2 });
      const step = maxSampleStep(left);
      // A steady 220Hz tone at 48kHz moves at most ~0.005 per sample; windowed
      // grains with bounded peaks must stay well below a click-sized jump.
      expect(step).toBeLessThan(0.06);
    }
  });

  it('starts and stops without clicks (fade in/out)', () => {
    const engine = new GrainEngine(SR);
    engine.setSource(generateMaterial('steady', SR), SR, 'steady');
    engine.setParams({ ...DEFAULT_PARAMS, density: 60, grainDuration: 0.08 });
    engine.play();
    const total = SR * 2;
    const left = new Float32Array(total);
    for (let off = 0; off < total; off += 128) {
      const n = Math.min(128, total - off);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      engine.process(l, r);
      left.set(l, off);
      if (off === SR) engine.stop();
    }
    for (let i = 1; i < left.length; i++) {
      expect(Math.abs(left[i] - left[i - 1])).toBeLessThan(0.05);
    }
    const tailStart = Math.floor(SR * 1.4);
    let tailEnergy = 0;
    for (let i = tailStart; i < left.length; i++) tailEnergy += Math.abs(left[i]);
    expect(tailEnergy).toBeLessThan(1);
  });

  it('keeps the output free of DC-forming offsets', () => {
    const { left, right } = render(40, { spread: 0 });
    let sumL = 0;
    let sumR = 0;
    for (let i = 0; i < left.length; i++) {
      sumL += left[i];
      sumR += right[i];
    }
    expect(Math.abs(sumL / left.length)).toBeLessThan(0.01);
    expect(Math.abs(sumR / right.length)).toBeLessThan(0.01);
  });
});
