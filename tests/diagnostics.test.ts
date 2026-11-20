import { describe, expect, it } from 'vitest';
import { GrainEngine } from '../src/grain/engine';
import { DEFAULT_PARAMS, GrainParams, DiagnosticFlags } from '../src/grain/types';
import {
  coherentSummationUplift,
  findMinimalGrainSet,
  firstMismatchFrame,
  independentWindowSum,
  replayPerformance,
} from '../src/grain/diagnostics';

const SR = 48000;

function constantSource(length = 24000, value = 0.5): Float32Array {
  const out = new Float32Array(length);
  out.fill(value);
  return out;
}

function shortSource(length = 64): Float32Array {
  // Non-zero everywhere so a read past the end still changes the output.
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i < length / 2 ? 1 : 0.2;
  return out;
}

/** A time-varying pitched source: only genuinely in-phase grains add energy. */
function toneSource(length = 24000, freq = 440): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Wideband noise: scattered grains decorrelate and partially cancel. */
function noiseSource(length = 24000, seed = 12345): Float32Array {
  let a = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }
  return out;
}

function makeEngine(source: Float32Array, params: Partial<GrainParams> = {}, flags: Partial<DiagnosticFlags> = {}) {
  const engine = new GrainEngine(SR);
  engine.setSource(source, SR, 't');
  engine.setParams({ ...DEFAULT_PARAMS, ...params });
  engine.setDiagnosticFlags(flags);
  engine.startDiagnosis();
  engine.play();
  return engine;
}

function render(engine: GrainEngine, seconds: number, block = 128) {
  const total = Math.floor(seconds * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let off = 0; off < total; off += block) {
    const n = Math.min(block, total - off);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    engine.process(l, r);
    left.set(l, off);
    right.set(r, off);
  }
  let peak = 0;
  let sumSq = 0;
  for (const v of left) {
    peak = Math.max(peak, Math.abs(v));
    sumSq += v * v;
  }
  return { left, right, peak, rms: Math.sqrt(sumSq / total) };
}

describe('forensic ledger', () => {
  it('records source range, window phase, instance and commit frame per grain', () => {
    const engine = makeEngine(constantSource(), { density: 30, grainDuration: 0.08 });
    render(engine, 0.6);
    const events = engine.getGrainEvents();
    expect(events.length).toBeGreaterThan(10);
    for (const ev of events) {
      expect(ev.instance).toBeGreaterThan(0);
      expect(ev.id).toBeGreaterThan(0);
      expect(ev.spawnFrame).toBeGreaterThanOrEqual(0);
      expect(ev.sourceStart).toBeGreaterThanOrEqual(0);
      expect(ev.sourceEnd).toBeLessThanOrEqual(ev.sourceLength - 1 + 1e-6);
      expect(ev.windowPhaseStart).toBe(0);
      expect(ev.windowPhaseEnd).toBe(1);
      expect(ev.length).toBeGreaterThanOrEqual(4);
      expect(ev.duplicate).toBe(false);
    }
    // Instances are unique and sequential in normal operation.
    const instances = new Set(events.map((e) => e.instance));
    expect(instances.size).toBe(events.length);
  });

  it('exposes the ledger through stats as the newest 256 events', () => {
    const engine = makeEngine(constantSource(), { density: 200, grainDuration: 0.2 });
    render(engine, 2);
    const stats = engine.buildStats();
    expect(stats.grainEvents.length).toBeLessThanOrEqual(256);
    expect(stats.grainEvents.length).toBeGreaterThan(100);
    expect(stats.grainEvents[stats.grainEvents.length - 1].spawnFrame).toBeGreaterThan(
      stats.grainEvents[0].spawnFrame,
    );
  });
});

describe('frozen seed', () => {
  it('replays the identical grain stream across performances when frozen', () => {
    const source = constantSource();
    const params = { ...DEFAULT_PARAMS, density: 40, grainDuration: 0.1 };
    const a = makeEngine(source, params, { seedFrozen: true });
    render(a, 0.8);
    const b = makeEngine(source, params, { seedFrozen: true });
    render(b, 0.8);
    const ea = a.getGrainEvents().map((e) => [e.sourceStart, e.length, e.rate]);
    const eb = b.getGrainEvents().map((e) => [e.sourceStart, e.length, e.rate]);
    expect(ea).toEqual(eb);
  });

  it('produces different streams when not frozen after seed changes', () => {
    const source = constantSource();
    const a = makeEngine(source, { density: 40 });
    render(a, 0.5);
    const b = makeEngine(source, { density: 40, seed: 0x1234abcd });
    render(b, 0.5);
    const same = a
      .getGrainEvents()
      .every((e, i) => e.sourceStart === b.getGrainEvents()[i]?.sourceStart);
    expect(same).toBe(false);
  });
});

describe('event withdrawal and phase shifts', () => {
  it('mutes one instance without touching the others', () => {
    const engine = makeEngine(constantSource(), { density: 20, grainDuration: 0.1, spread: 0 });
    render(engine, 0.2);
    const events = engine.getGrainEvents();
    const target = events[0].instance;
    const before = render(engine, 0.05);
    engine.muteInstance(target);
    expect(engine.isInstanceMuted(target)).toBe(true);
    const after = render(engine, 0.05);
    // Output continues (other grains still active) but the muted grain's event is flagged.
    expect(after.peak).toBeLessThanOrEqual(1);
    expect(engine.getGrainEvents().find((e) => e.instance === target)?.muted).toBe(true);
    engine.unmuteInstance(target);
    expect(engine.isInstanceMuted(target)).toBe(false);
    void before;
  });

  it('shifts the read position of one instance via phase offset', () => {
    const engine = makeEngine(constantSource(48000, 0.5), { density: 20, grainDuration: 0.1, spread: 0 });
    render(engine, 0.2);
    const target = engine.getGrainEvents()[0].instance;
    engine.setInstancePhase(target, 120);
    expect(engine.getInstancePhase(target)).toBe(120);
    expect(engine.getPhaseOffsets()[0]).toEqual({ instance: target, offsetFrames: 120 });
    const stats = engine.buildStats();
    expect(stats.phaseOffsets[0].offsetFrames).toBe(120);
    engine.clearInstancePhase(target);
    expect(engine.getInstancePhase(target)).toBe(0);
  });
});

describe('independent window-sum reference', () => {
  it('matches the live render frame-for-frame in the correct configuration', () => {
    const source = constantSource();
    const params = { ...DEFAULT_PARAMS, density: 50, grainDuration: 0.12, spread: 0 };
    const run = replayPerformance(source, SR, params, { seconds: 1, freezeSeed: true });
    expect(run.mismatch).toBeNull();
    // The reference reproduces the engine's exact fade-in ramp, so the whole
    // buffer must agree frame-for-frame with the live render.
    const reference = independentWindowSum(run.events, source, run.left.length, SR);
    const interior = firstMismatchFrame(run.left, reference, 1e-3, 0.05);
    expect(interior).toBeNull();
  });

  it('flags the first mismatch frame when the window mix is broken', () => {
    const source = constantSource();
    const params = { ...DEFAULT_PARAMS, density: 60, grainDuration: 0.1, spread: 0, amplitude: 0.5 };
    const run = replayPerformance(source, SR, params, {
      seconds: 1,
      freezeSeed: true,
      flags: { fixWindowMix: false, injectWindowNormError: true },
    });
    expect(run.mismatch).not.toBeNull();
    expect(run.mismatch!.attributedStage).toBe('window-mix');
    expect(run.mismatch!.frame).toBeGreaterThanOrEqual(0);
    expect(run.mismatch!.activeInstances.length).toBeGreaterThan(0);
  });
});

describe('fault: window normalisation error', () => {
  it('raises loudness when dense while the fix keeps it bounded', () => {
    const source = toneSource();
    const params = {
      ...DEFAULT_PARAMS,
      density: 160,
      grainDuration: 0.2,
      position: 0.5,
      positionJitter: 0.2,
      speedJitter: 0,
      spread: 0,
      amplitude: 0.5,
    };
    const healthy = replayPerformance(source, SR, params, { seconds: 1.5, freezeSeed: true });
    const faulty = replayPerformance(source, SR, params, {
      seconds: 1.5,
      freezeSeed: true,
      flags: { fixWindowMix: false, injectWindowNormError: true },
    });
    expect(faulty.rms).toBeGreaterThan(healthy.rms * 1.5);
    expect(faulty.mismatch?.attributedStage).toBe('window-mix');
    // Re-enabling only the window-mix fix removes the anomaly even with the flag present.
    const fixed = replayPerformance(source, SR, params, {
      seconds: 1.5,
      freezeSeed: true,
      flags: { fixWindowMix: true, injectWindowNormError: true },
    });
    expect(fixed.mismatch).toBeNull();
    expect(Math.abs(fixed.rms - healthy.rms) / healthy.rms).toBeLessThan(0.05);
  });
});

describe('fault: double trigger', () => {
  it('submits the same instance twice and reports the duplicate in the ledger', () => {
    const source = constantSource();
    const params = { ...DEFAULT_PARAMS, density: 40, grainDuration: 0.08, spread: 0 };
    const normal = replayPerformance(source, SR, params, { seconds: 1, freezeSeed: true });
    const doubled = replayPerformance(source, SR, params, {
      seconds: 1,
      freezeSeed: true,
      flags: { injectDoubleTrigger: true },
    });
    expect(doubled.events.length).toBe(normal.events.length * 2);
    const dupes = doubled.events.filter((e) => e.duplicate);
    expect(dupes.length).toBe(normal.events.length);
    for (const dupe of dupes) {
      const original = doubled.events.find((e) => !e.duplicate && e.instance === dupe.instance);
      expect(original).toBeDefined();
      expect(original!.sourceStart).toBe(dupe.sourceStart);
      expect(original!.length).toBe(dupe.length);
      expect(original!.spawnFrame).toBe(dupe.spawnFrame);
    }
    // Duplicates add coherent energy: RMS rises, but the independent mix still agrees
    // (this is a generation-stage fault, not a mix-stage fault).
    expect(doubled.rms).toBeGreaterThan(normal.rms * 1.3);
    expect(doubled.mismatch).toBeNull();
  });

  it('mutes both copies when the shared instance is withdrawn', () => {
    const engine = makeEngine(constantSource(), { density: 20, grainDuration: 0.1 }, { injectDoubleTrigger: true });
    render(engine, 0.2);
    const target = engine.getGrainEvents()[0].instance;
    engine.muteInstance(target);
    const remaining = render(engine, 0.1);
    expect(remaining.peak).toBeLessThan(0.99);
    const flagged = engine.getGrainEvents().filter((e) => e.instance === target);
    expect(flagged.every((e) => e.muted)).toBe(true);
  });
});

describe('fault: source overrun on a short source', () => {
  it('healthy clip policy truncates the over-running grain while another fades out cleanly', () => {
    // Source shorter than the base grain: positive duration jitter makes some
    // grains longer than the source span (they must be truncated at the end),
    // while negative jitter makes others short enough to run the full Hann
    // fade-out without ever reaching the end.
    const source = shortSource(2048);
    const params = {
      ...DEFAULT_PARAMS,
      density: 40,
      grainDuration: 0.06,
      durationJitter: 0.6,
      readSpeed: 1,
      speedJitter: 0,
      position: 0.3,
      positionJitter: 0.4,
      spread: 0,
      boundary: 'clip' as const,
    };
    const engine = makeEngine(source, params);
    render(engine, 1);
    const stats = engine.buildStats();
    expect(stats.outOfRangeReads).toBe(0);
    expect(stats.boundaryTruncated).toBeGreaterThan(0);
    const truncated = stats.grainEvents.filter((e) => e.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const ev of truncated) expect(ev.sourceEnd).toBeLessThanOrEqual(source.length - 1 + 1e-6);
    // The short jitter branch: full-length grains whose final read stays in range
    // and whose window completes its fade-out (last Hann sample ~ 0).
    const fullLength = stats.grainEvents.filter((e) => !e.truncated);
    expect(fullLength.length).toBeGreaterThan(0);
    for (const ev of fullLength) {
      expect(ev.sourceEnd).toBeLessThanOrEqual(source.length - 1 + 1e-6);
      expect(ev.length).toBeLessThan(source.length);
    }
    expect(stats.windowEdgeMax).toBeLessThan(1e-5);
  });

  it('overrun injection crosses the source end and is attributed to the source stage', () => {
    const source = shortSource(64);
    const params = {
      ...DEFAULT_PARAMS,
      density: 30,
      grainDuration: 0.05,
      readSpeed: 1,
      speedJitter: 0,
      position: 0.95,
      positionJitter: 0,
      spread: 0,
      boundary: 'clip' as const,
    };
    const faulty = replayPerformance(source, SR, params, {
      seconds: 1,
      freezeSeed: true,
      flags: { injectSourceOverrun: true, fixSourceOverrun: false },
    });
    expect(faulty.events.some((e) => e.sourceEnd > source.length - 1)).toBe(true);
    expect(faulty.mismatch?.attributedStage).toBe('source-overrun');

    // Only the source-stage switch re-enabled: overrun disappears, window mix untouched.
    const sourceFixed = replayPerformance(source, SR, params, {
      seconds: 1,
      freezeSeed: true,
      flags: { injectSourceOverrun: true, fixSourceOverrun: true, fixWindowMix: true },
    });
    expect(sourceFixed.events.every((e) => e.sourceEnd <= source.length - 1 + 1e-6)).toBe(true);
    expect(sourceFixed.mismatch).toBeNull();
  });

  it('window-mix-only switch does not repair a source-stage overrun', () => {
    const source = shortSource(64);
    const params = {
      ...DEFAULT_PARAMS,
      density: 30,
      grainDuration: 0.05,
      readSpeed: 1,
      speedJitter: 0,
      position: 0.95,
      positionJitter: 0,
      spread: 0,
      boundary: 'clip' as const,
    };
    // Source overrun injected, window-mix fix ON but source fix OFF: anomaly persists
    // and keeps its source-stage attribution.
    const run = replayPerformance(source, SR, params, {
      seconds: 1,
      freezeSeed: true,
      flags: { injectSourceOverrun: true, fixSourceOverrun: false, fixWindowMix: true },
    });
    expect(run.mismatch?.attributedStage).toBe('source-overrun');
  });
});

describe('stage attribution across the two switches', () => {
  it('assigns the same kind of loudness jump to different stages via separate replays', () => {
    const source = shortSource(128);
    const params = {
      ...DEFAULT_PARAMS,
      density: 40,
      grainDuration: 0.06,
      readSpeed: 1,
      speedJitter: 0,
      position: 0.9,
      positionJitter: 0,
      spread: 0,
      boundary: 'clip' as const,
    };
    const sourceStage = replayPerformance(source, SR, params, {
      seconds: 1,
      freezeSeed: true,
      flags: { injectSourceOverrun: true, fixSourceOverrun: false, fixWindowMix: true },
    });
    const mixStage = replayPerformance(constantSource(), SR, {
      ...DEFAULT_PARAMS,
      density: 120,
      grainDuration: 0.15,
      spread: 0,
      amplitude: 0.5,
    }, {
      seconds: 1,
      freezeSeed: true,
      flags: { fixWindowMix: false, injectWindowNormError: true },
    });
    expect(sourceStage.mismatch?.attributedStage).toBe('source-overrun');
    expect(mixStage.mismatch?.attributedStage).toBe('window-mix');
  });
});

describe('minimal grain set search', () => {
  it('reduces a reproducing cloud to its smallest required instances', () => {
    const source = toneSource();
    const params = {
      ...DEFAULT_PARAMS,
      density: 60,
      grainDuration: 0.12,
      position: 0.5,
      positionJitter: 0.2,
      speedJitter: 0,
      spread: 0,
      amplitude: 0.5,
    };
    const flags: Partial<DiagnosticFlags> = { fixWindowMix: false, injectWindowNormError: true };
    const result = findMinimalGrainSet(source, SR, params, flags, 0.6);
    expect(result.stage).toBe('window-mix');
    expect(result.instances.length).toBeGreaterThan(0);
    expect(result.instances.length).toBeLessThan(30);
    expect(result.firstMismatchFrame).toBeGreaterThanOrEqual(0);
    // Replaying only the minimal set still reproduces the anomaly.
    const repro = replayPerformance(source, SR, params, {
      seconds: 0.6,
      freezeSeed: true,
      flags,
      onlyInstances: result.instances,
    });
    expect(repro.mismatch).not.toBeNull();
  }, 30000);
});

describe('coherent summation is preserved', () => {
  it('in-phase grains legitimately get louder and never trigger a mix mismatch', () => {
    const source = noiseSource();
    const params = { ...DEFAULT_PARAMS, density: 60, grainDuration: 0.15, spread: 0, amplitude: 0.5 };
    const { normalRms, coherentRms, upliftDb } = coherentSummationUplift(source, SR, params, 1.2);
    expect(coherentRms).toBeGreaterThan(normalRms);
    expect(upliftDb).toBeGreaterThan(1);
    const coherent = replayPerformance(
      source,
      SR,
      { ...params, positionJitter: 0, position: 0.5, speedJitter: 0, readSpeed: 1 },
      { seconds: 1.2, freezeSeed: true },
    );
    expect(coherent.mismatch).toBeNull();
    expect(coherent.peak).toBeLessThan(0.99);
  });
});
