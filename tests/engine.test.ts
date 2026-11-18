import { describe, expect, it } from 'vitest';
import { GrainEngine, ENGINE_LIMITS } from '../src/grain/engine';
import { DEFAULT_PARAMS, GrainParams } from '../src/grain/types';
import { generateMaterial } from '../src/grain/materials';

const SR = 48000;

function makeEngine(params: Partial<GrainParams> = {}) {
  const engine = new GrainEngine(SR);
  const source = generateMaterial('steady', SR);
  engine.setSource(source, SR, 'steady');
  engine.setParams({ ...DEFAULT_PARAMS, ...params });
  return { engine, source };
}

function render(engine: GrainEngine, seconds: number, block = 128): { left: Float32Array; right: Float32Array } {
  const total = Math.floor(seconds * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  for (let offset = 0; offset < total; offset += block) {
    const n = Math.min(block, total - offset);
    const sl = l.subarray(0, n);
    const sr = r.subarray(0, n);
    engine.process(sl, sr);
    left.set(sl, offset);
    right.set(sr, offset);
  }
  return { left, right };
}

function renderBlocks(engine: GrainEngine, seconds: number, blockSizes: number[]): number {
  const total = Math.floor(seconds * SR);
  let offset = 0;
  let i = 0;
  while (offset < total) {
    const n = Math.min(blockSizes[i % blockSizes.length], total - offset);
    engine.process(new Float32Array(n), new Float32Array(n));
    offset += n;
    i++;
  }
  return i;
}

describe('grain scheduling', () => {
  it('produces the requested average density independent of block size', () => {
    const results: number[] = [];
    for (const block of [64, 128, 256, 480, 1024]) {
      const { engine } = makeEngine({ density: 40, grainDuration: 0.08 });
      engine.play();
      render(engine, 2.0, block);
      const stats = engine.buildStats();
      results.push(stats.measuredDensity);
    }
    for (const density of results) {
      expect(density).toBeGreaterThan(40 * 0.85);
      expect(density).toBeLessThan(40 * 1.15);
    }
  });

  it('keeps density stable when the host changes quantum size mid-stream', () => {
    const { engine } = makeEngine({ density: 30, grainDuration: 0.1 });
    engine.play();
    const blocks = renderBlocks(engine, 2.5, [128, 128, 512, 96, 1024, 256, 64]);
    expect(blocks).toBeGreaterThan(10);
    const stats = engine.buildStats();
    expect(stats.measuredDensity).toBeGreaterThan(30 * 0.85);
    expect(stats.measuredDensity).toBeLessThan(30 * 1.15);
  });

  it('spawns at sample-level precision regardless of host quantum', () => {
    const { engine } = makeEngine({ density: 100, grainDuration: 0.02, durationJitter: 0, speedJitter: 0 });
    engine.play();
    render(engine, 1.0, 512);
    const stats = engine.buildStats();
    expect(stats.spawnCount).toBeGreaterThan(90);
    expect(stats.spawnCount).toBeLessThan(115);
  });

  it('caps the pool and reports drop-outs instead of unbounded growth', () => {
    const { engine } = makeEngine({
      density: 400,
      grainDuration: 2,
      amplitude: 0.5,
      masterGain: 1,
    });
    engine.play();
    render(engine, 1.5, 128);
    const stats = engine.buildStats();
    expect(stats.peakActive).toBeLessThanOrEqual(ENGINE_LIMITS.maxActive);
    expect(stats.currentActive).toBeLessThanOrEqual(ENGINE_LIMITS.maxActive);
    expect(stats.dropped).toBeGreaterThan(0);
  });

  it('never lets peak output grow without bound as density increases', () => {
    const peaks: number[] = [];
    for (const density of [10, 40, 120, 300]) {
      const { engine } = makeEngine({ density, grainDuration: 0.2, durationJitter: 0, amplitude: 0.5 });
      engine.play();
      const { left, right } = render(engine, 1.2, 128);
      let peak = 0;
      for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      peaks.push(peak);
      expect(peak).toBeLessThan(0.99);
    }
    expect(peaks[peaks.length - 1]).toBeLessThan(peaks[0] * 4);
  });
});

describe('edge policy', () => {
  it('clip policy never reads out of range and ends grains as Hann windows close', () => {
    const { engine, source } = makeEngine({
      boundary: 'clip',
      readSpeed: 4,
      speedJitter: 0,
      grainDuration: 0.5,
      density: 60,
      position: 0.9,
      positionJitter: 0.1,
    });
    engine.play();
    render(engine, 1.5, 128);
    const stats = engine.buildStats();
    expect(stats.outOfRangeReads).toBe(0);
    expect(stats.readPosMin).toBeGreaterThanOrEqual(0);
    expect(stats.readPosMax).toBeLessThanOrEqual(source.length - 1);
    expect(stats.windowEdgeMax).toBeLessThan(1e-5);
    expect(stats.nanSamples).toBe(0);
  });

  it('clip policy shortens grains that would overrun the sample', () => {
    const { engine } = makeEngine({
      boundary: 'clip',
      readSpeed: 4,
      speedJitter: 0,
      durationJitter: 0,
      grainDuration: 1.0,
      density: 20,
    });
    engine.play();
    render(engine, 0.5, 128);
    const stats = engine.buildStats();
    expect(stats.boundaryTruncated).toBeGreaterThan(0);
    expect(stats.outOfRangeReads).toBe(0);
  });

  it('loop policy wraps inside the source without out-of-range reads', () => {
    const { engine, source } = makeEngine({
      boundary: 'loop',
      readSpeed: 3,
      speedJitter: 0,
      durationJitter: 0,
      grainDuration: 0.6,
      density: 30,
      position: 0.5,
      positionJitter: 0.4,
    });
    engine.play();
    render(engine, 1.2, 128);
    const stats = engine.buildStats();
    expect(stats.loopWraps).toBeGreaterThan(0);
    expect(stats.outOfRangeReads).toBe(0);
    expect(stats.readPosMax).toBeLessThanOrEqual(source.length - 1);
    expect(stats.windowEdgeMax).toBeLessThan(1e-5);
  });

  it('window edges stay at zero for every grain duration', () => {
    for (const duration of [0.01, 0.05, 0.12, 0.4, 1.0]) {
      const { engine } = makeEngine({ grainDuration: duration, durationJitter: 0.5, density: 80 });
      engine.play();
      render(engine, 0.8, 128);
      expect(engine.buildStats().windowEdgeMax).toBeLessThan(1e-5);
    }
  });
});

describe('time behaviour independent of UI', () => {
  it('continues to advance sample time while paused and resumes the grain grid', () => {
    const { engine } = makeEngine({ density: 20 });
    engine.play();
    render(engine, 0.5, 128);
    const before = engine.buildStats();
    engine.pause();
    render(engine, 1.0, 128);
    const paused = engine.buildStats();
    expect(paused.paused).toBe(true);
    expect(paused.renderedFrames).toBeGreaterThan(before.renderedFrames + SR * 0.9);
    engine.resume();
    render(engine, 0.6, 128);
    const resumed = engine.buildStats();
    expect(resumed.spawnCount).toBeGreaterThan(paused.spawnCount);
    expect(resumed.measuredDensity).toBeGreaterThan(20 * 0.7);
  });

  it('does not depend on requestAnimationFrame being called', () => {
    // No rAF exists in Node; rendering through the engine alone must produce grains.
    const { engine } = makeEngine({ density: 50 });
    engine.play();
    render(engine, 1.0, 128);
    const stats = engine.buildStats();
    expect(stats.spawnCount).toBeGreaterThan(40);
    expect(stats.continuity).toBeGreaterThan(0.5);
  });
});

describe('continuity and recording', () => {
  it('reports high continuity for a steady dense cloud', () => {
    const { engine } = makeEngine({ density: 80, grainDuration: 0.25, durationJitter: 0.1 });
    engine.play();
    render(engine, 2.0, 128);
    const stats = engine.buildStats();
    expect(stats.continuity).toBeGreaterThan(0.95);
    expect(stats.longestSilentMs).toBeLessThan(30);
  });

  it('reports low continuity for a sparse cloud', () => {
    const { engine } = makeEngine({ density: 3, grainDuration: 0.03, durationJitter: 0 });
    engine.play();
    render(engine, 3.0, 128);
    const stats = engine.buildStats();
    expect(stats.continuity).toBeLessThan(0.8);
    expect(stats.silentWindows).toBeGreaterThan(0);
  });

  it('records only real output and drains it in full', () => {
    const { engine } = makeEngine({ density: 20, grainDuration: 0.1 });
    engine.play();
    expect(engine.startRecording()).toBe(true);
    const { left } = render(engine, 1.0, 128);
    let recorded = 0;
    let drainedLeft = new Float32Array(0);
    for (;;) {
      const chunk = engine.drainRecorded();
      if (!chunk) break;
      const merged = new Float32Array(drainedLeft.length + chunk.frames);
      merged.set(drainedLeft);
      merged.set(chunk.left, drainedLeft.length);
      drainedLeft = merged;
      recorded += chunk.frames;
    }
    expect(recorded).toBeGreaterThan(SR * 0.9);
    expect(recorded).toBeLessThanOrEqual(SR * 1.05);
    let energy = 0;
    for (let i = 0; i < drainedLeft.length; i++) energy += Math.abs(drainedLeft[i]);
    expect(energy).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(left.length, drainedLeft.length); i++) {
      if (Math.abs(left[i]) > 0.01) {
        expect(drainedLeft[i]).toBeCloseTo(left[i], 3);
        break;
      }
    }
  });
});

describe('parameters', () => {
  it('clamps hostile parameters instead of producing silence or NaN', () => {
    const { engine } = makeEngine();
    engine.setParams({ density: -50, grainDuration: 0, readSpeed: 1e6, position: 5, positionJitter: 9 });
    engine.play();
    const { left, right } = render(engine, 0.5, 128);
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true);
      expect(Number.isFinite(right[i])).toBe(true);
    }
    const stats = engine.buildStats();
    expect(stats.nanSamples).toBe(0);
    expect(stats.outOfRangeReads).toBe(0);
  });

  it('changes density immediately without rebuilding the graph', () => {
    const { engine } = makeEngine({ density: 10, grainDuration: 0.1 });
    engine.play();
    render(engine, 1.0, 128);
    const low = engine.buildStats().measuredDensity;
    engine.setParams({ density: 80 });
    render(engine, 1.5, 128);
    const high = engine.buildStats().measuredDensity;
    expect(high).toBeGreaterThan(low * 2);
  });
});

describe('materials', () => {
  it('all three built-in materials drive the engine without anomalies', () => {
    for (const id of ['impulse', 'steady', 'transient'] as const) {
      const engine = new GrainEngine(SR);
      engine.setSource(generateMaterial(id, SR), SR, id);
      engine.setParams({ ...DEFAULT_PARAMS, density: 70, grainDuration: 0.1, position: 1, positionJitter: 1, boundary: 'clip' });
      engine.play();
      render(engine, 1.2, 128);
      const stats = engine.buildStats();
      expect(stats.outOfRangeReads).toBe(0);
      expect(stats.nanSamples).toBe(0);
      expect(stats.windowEdgeMax).toBeLessThan(1e-5);
      expect(stats.currentActive).toBeLessThanOrEqual(stats.capacity);
      expect(stats.peak).toBeGreaterThan(0);
      expect(stats.peak).toBeLessThan(0.99);
    }
  });
});

describe('recording overflow', () => {
  it('stops at the configured cap and flags dropped audio', () => {
    const engine = new GrainEngine(SR);
    engine.setSource(generateMaterial('steady', SR), SR, 'steady');
    engine.setParams({ ...DEFAULT_PARAMS, density: 40 });
    engine.play();
    expect(engine.startRecording()).toBe(true);
    // Render beyond the 60s cap without draining: drops must be reported.
    render(engine, ENGINE_LIMITS.recordSeconds + 1, 1024);
    const stats = engine.buildStats();
    expect(stats.recordActive).toBe(false);
    expect(stats.recordDropped).toBe(true);
    expect(stats.recordFrames).toBeLessThanOrEqual(ENGINE_LIMITS.recordSeconds * SR);
  });
});
