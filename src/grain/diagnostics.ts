import { GrainEngine } from './engine';
import { DiagnosticFlags, GrainEvent, GrainParams, MinimizationResult, MixMismatch } from './types';
import { fadeEnvelopeAt, windowAt } from './window';

export interface ReplayOptions {
  seconds: number;
  blockSize?: number;
  /** Only these instances are rendered; empty/undefined means "all". */
  onlyInstances?: number[];
  /** Muted instance numbers. */
  mutedInstances?: number[];
  /** Per-instance signed source-frame phase shifts. */
  phaseOffsets?: Map<number, number>;
  flags?: Partial<DiagnosticFlags>;
  /** When true, the engine is started with the frozen-seed behaviour. */
  freezeSeed?: boolean;
}

export interface ReplayResult {
  left: Float32Array;
  right: Float32Array;
  events: GrainEvent[];
  mismatch: MixMismatch | null;
  peak: number;
  rms: number;
}

/**
 * Renders a deterministic offline performance of the given source/params through
 * a fresh engine. Used by the diagnostic workbench so removing events or shifting
 * a phase always replays the exact same grain stream.
 */
export function replayPerformance(
  source: Float32Array,
  sourceRate: number,
  params: GrainParams,
  options: ReplayOptions,
): ReplayResult {
  const engine = new GrainEngine(sourceRate);
  engine.setSource(source, sourceRate, 'diagnostic-replay');
  engine.setParams({ ...params });
  const flags: Partial<DiagnosticFlags> = { ...(options.flags ?? {}) };
  if (options.freezeSeed) flags.seedFrozen = true;
  engine.setDiagnosticFlags(flags);
  engine.startDiagnosis();
  engine.play();
  for (const instance of options.mutedInstances ?? []) engine.muteInstance(instance);
  for (const [instance, offset] of options.phaseOffsets ?? []) engine.setInstancePhase(instance, offset);

  const keep = options.onlyInstances && options.onlyInstances.length > 0 ? new Set(options.onlyInstances) : null;
  const seen = new Set<number>();
  const applyLateRules = () => {
    if (!keep) return;
    for (const ev of engine.getGrainEvents()) {
      if (seen.has(ev.instance)) continue;
      seen.add(ev.instance);
      if (!keep.has(ev.instance)) engine.muteInstance(ev.instance);
    }
  };

  const block = options.blockSize ?? 128;
  const total = Math.floor(options.seconds * sourceRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let off = 0; off < total; off += block) {
    applyLateRules();
    const n = Math.min(block, total - off);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    engine.process(l, r);
    left.set(l, off);
    right.set(r, off);
  }
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < total; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    sumSq += left[i] * left[i];
  }
  return {
    left,
    right,
    events: engine.getGrainEvents(),
    mismatch: engine.getMixMismatch(),
    peak,
    rms: Math.sqrt(sumSq / Math.max(1, total)),
  };
}

/**
 * Fully independent grain-sum calculator rebuilt from the ledger alone. It never
 * touches the live mix code, so its output is the ground truth for "what the
 * windowed overlap ought to be".
 */
export function independentWindowSum(
  events: GrainEvent[],
  source: Float32Array,
  totalFrames: number,
  sampleRate?: number,
): Float32Array {
  const out = new Float32Array(totalFrames);
  const srcLen = source.length;
  for (const ev of events) {
    if (ev.muted) continue;
    const origin = ev.spawnFrame;
    for (let age = 0; age < ev.length; age++) {
      const frame = origin + age;
      if (frame < 0 || frame >= totalFrames) continue;
      const w = windowAt(age, ev.length);
      let pos = ev.sourceStart + age * ev.rate + ev.phaseOffset;
      if (pos > srcLen - 1) pos = srcLen - 1;
      else if (pos < 0) pos = 0;
      const i0 = pos | 0;
      const frac = pos - i0;
      const i1 = Math.min(i0 + 1, srcLen - 1);
      const s = source[i0] + (source[i1] - source[i0]) * frac;
      out[frame] += s * ev.gainL * w;
    }
  }
  // Match the engine's post-render fade-in so the comparison covers the entire
  // buffer, including the opening ramp, rather than only the steady interior.
  if (sampleRate !== undefined) {
    for (let frame = 0; frame < totalFrames; frame++) {
      out[frame] *= fadeEnvelopeAt(frame, sampleRate);
    }
  }
  return out;
}

/**
 * First frame where the live render disagrees with the independent sum.
 * Tolerance combines an absolute floor (near-silence frames) with a relative
 * margin (dense frames), matching the engine scanner: the live render also
 * passes through the feed-forward limiter, so tiny gain differences are not
 * evidence of a generation or mixing fault.
 */
export function firstMismatchFrame(
  live: Float32Array,
  reference: Float32Array,
  tolerance = 1e-4,
  relativeTolerance = 0.05,
): MixMismatch | null {
  const n = Math.min(live.length, reference.length);
  for (let frame = 0; frame < n; frame++) {
    const delta = Math.abs(live[frame] - reference[frame]);
    const threshold = Math.max(tolerance, Math.abs(reference[frame]) * relativeTolerance);
    if (delta > threshold) {
      return {
        frame,
        delta,
        live: live[frame],
        reference: reference[frame],
        activeInstances: [],
        attributedStage: 'unknown',
      };
    }
  }
  return null;
}

/**
 * Zeller/Hildebrandt delta-debugging (ddmin): repeatedly bisect the candidate
 * set, keeping whichever subset still reproduces the anomaly, until every
 * remaining instance is required. Each replay is one fresh deterministic
 * performance, so the search cost is O(n log n) replays.
 */
export function findMinimalGrainSet(
  source: Float32Array,
  sourceRate: number,
  params: GrainParams,
  flags: Partial<DiagnosticFlags>,
  seconds: number,
): MinimizationResult {
  const baseline = replayPerformance(source, sourceRate, params, { seconds, flags, freezeSeed: true });
  const allInstances = [...new Set(baseline.events.map((e) => e.instance))].sort((a, b) => a - b);
  if (allInstances.length === 0 || !baseline.mismatch) {
    return {
      instances: allInstances,
      peakDelta: 0,
      firstMismatchFrame: baseline.mismatch?.frame ?? -1,
      stage: baseline.mismatch?.attributedStage ?? 'none',
    };
  }

  const threshold = Math.max(1e-4, baseline.mismatch.delta * 0.5);
  const stage = baseline.mismatch.attributedStage;

  const reproduces = (instances: number[]): { reproduces: boolean; score: number; firstFrame: number } => {
    const keep = new Set(instances);
    const muted = allInstances.filter((i) => !keep.has(i));
    const run = replayPerformance(source, sourceRate, params, {
      seconds,
      flags,
      freezeSeed: true,
      mutedInstances: muted,
    });
    return {
      reproduces: !!run.mismatch && run.mismatch.delta >= threshold,
      score: run.mismatch?.delta ?? 0,
      firstFrame: run.mismatch?.frame ?? -1,
    };
  };

  let current = allInstances;
  let chunkSize = Math.ceil(current.length / 2);
  while (current.length > 1 && chunkSize >= 1) {
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const complement = [...current.slice(0, start), ...current.slice(start + chunkSize)];
      if (complement.length === 0) continue;
      if (reproduces(complement).reproduces) {
        current = complement;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunkSize === current.length) break;
      chunkSize = Math.max(1, Math.floor(chunkSize / 2));
    } else {
      chunkSize = Math.max(1, Math.ceil(current.length / 2));
    }
  }

  const finalRun = reproduces(current);
  return {
    instances: current,
    peakDelta: finalRun.score,
    firstMismatchFrame: finalRun.firstFrame,
    stage,
  };
}

/**
 * Compares a normal replay against an all-in-phase replay where every grain
 * reads the same source position. Returns the RMS uplift that coherent summation
 * genuinely adds, so it can be distinguished from fault-driven loudness.
 */
export function coherentSummationUplift(
  source: Float32Array,
  sourceRate: number,
  params: GrainParams,
  seconds: number,
): { normalRms: number; coherentRms: number; upliftDb: number } {
  // The "normal" cloud scatters read positions so grain signals partially cancel;
  // the coherent cloud pins every grain to the same position/rate, isolating the
  // loudness that legitimate in-phase summation genuinely contributes.
  const normalParams: GrainParams = {
    ...params,
    position: 0.5,
    positionJitter: 1,
    speedJitter: 0.5,
    readSpeed: 2,
  };
  const normal = replayPerformance(source, sourceRate, normalParams, { seconds, freezeSeed: true });
  const coherentParams: GrainParams = {
    ...params,
    positionJitter: 0,
    position: 0.5,
    speedJitter: 0,
    readSpeed: 1,
  };
  const coherent = replayPerformance(source, sourceRate, coherentParams, { seconds, freezeSeed: true });
  const upliftDb = 20 * Math.log10(coherent.rms / Math.max(1e-9, normal.rms));
  return { normalRms: normal.rms, coherentRms: coherent.rms, upliftDb };
}
