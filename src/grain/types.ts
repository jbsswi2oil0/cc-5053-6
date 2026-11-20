export type BoundaryPolicy = 'clip' | 'loop';

export interface GrainParams {
  /** grains per second */
  density: number;
  /** base grain duration in seconds */
  grainDuration: number;
  /** 0..1 proportional duration jitter */
  durationJitter: number;
  /** base read speed multiplier */
  readSpeed: number;
  /** 0..1 proportional read-speed jitter */
  speedJitter: number;
  /** base position in source (0..1) */
  position: number;
  /** 0..1 fraction of the source used as position jitter half-range */
  positionJitter: number;
  /** 0..1 stereo spread */
  spread: number;
  boundary: BoundaryPolicy;
  /** per-grain linear amplitude before overlap normalisation */
  amplitude: number;
  masterGain: number;
  seed: number;
}

export interface GrainView {
  p: number;
  pan: number;
  age: number;
  duration: number;
  rate: number;
  id: number;
}

/**
 * Per-grain forensic ledger entry. Every spawned grain records exactly where it
 * reads from the source, where it sits on its Hann window, which instance number
 * it carries and on which rendered sample it was actually committed.
 */
export interface GrainEvent {
  /** Monotonic instance number, shared by double-triggered duplicates. */
  instance: number;
  /** Unique slot id assigned by the engine. */
  id: number;
  /** Engine frame on which the grain's first sample was rendered. */
  spawnFrame: number;
  /** Source sample the grain starts reading at. */
  sourceStart: number;
  /** Source sample reached by the grain's final read (inclusive). */
  sourceEnd: number;
  /** Source length at spawn time, so an overrun is visible from the record alone. */
  sourceLength: number;
  /** Grain length in rendered samples. */
  length: number;
  /** Read pointer advance per rendered sample. */
  rate: number;
  /** Window phase of the first sample (always 0) and last sample (always 1). */
  windowPhaseStart: number;
  windowPhaseEnd: number;
  /** Pan in [-1, 1], gain applied per channel, and the norm gain captured at spawn. */
  pan: number;
  gainL: number;
  gainR: number;
  normGain: number;
  /** True when the grain was shortened by the clip boundary policy. */
  truncated: boolean;
  /** True for the second copy emitted by the double-trigger fault. */
  duplicate: boolean;
  /** Diagnostic phase offset (source frames) applied to this instance. */
  phaseOffset: number;
  /** Diagnostic mute: a muted instance contributes silence. */
  muted: boolean;
}

/** Switches used by the diagnostic workbench. Fixes default ON (correct engine). */
export interface DiagnosticFlags {
  /** Source-stage fix: clip-policy grains are truncated and reads stay in range. */
  fixSourceOverrun: boolean;
  /** Mix-stage fix: Hann window applied multiplicatively with global power norm. */
  fixWindowMix: boolean;
  /** Fault injection: the same grain parameters trigger a second time. */
  injectDoubleTrigger: boolean;
  /** Fault injection: per-grain window normalisation (divide by window value). */
  injectWindowNormError: boolean;
  /** Fault injection: clip-policy grains may read past the source end. */
  injectSourceOverrun: boolean;
  /** Freeze the PRNG stream at the start of a performance window. */
  seedFrozen: boolean;
}

export const DEFAULT_DIAGNOSTIC_FLAGS: DiagnosticFlags = {
  fixSourceOverrun: true,
  fixWindowMix: true,
  injectDoubleTrigger: false,
  injectWindowNormError: false,
  injectSourceOverrun: false,
  seedFrozen: false,
};

/** Result of comparing live output against an independent window-sum reference. */
export interface MixMismatch {
  /** First rendered frame whose live output disagrees with the reference. */
  frame: number;
  /** Absolute difference between live and reference at that frame. */
  delta: number;
  live: number;
  reference: number;
  /** Instance numbers active on the offending frame. */
  activeInstances: number[];
  /** Stage attribution derived from the active fix switches. */
  attributedStage: 'none' | 'source-overrun' | 'window-mix' | 'unknown';
}

/** Outcome of the minimal-grain-set delta search. */
export interface MinimizationResult {
  /** Instance numbers of the smallest grain set still producing the anomaly. */
  instances: number[];
  peakDelta: number;
  firstMismatchFrame: number;
  stage: MixMismatch['attributedStage'];
}

export interface GrainStats {
  playing: boolean;
  paused: boolean;
  sampleLoaded: boolean;
  sourceName: string;
  sourceLength: number;
  sampleRate: number;
  renderedFrames: number;
  sessionSeconds: number;
  requestedDensity: number;
  spawnCount: number;
  epochSpawnCount: number;
  measuredDensity: number;
  currentActive: number;
  peakActive: number;
  capacity: number;
  dropped: number;
  boundaryTruncated: number;
  boundarySkipped: number;
  loopWraps: number;
  outOfRangeReads: number;
  nanSamples: number;
  windowEdgeMax: number;
  readPosMin: number;
  readPosMax: number;
  peak: number;
  densityPeak: number;
  densityActivePeak: number;
  rms: number;
  limiterMaxReductionDb: number;
  limiterEngagedFrames: number;
  normGain: number;
  expectedOverlap: number;
  continuity: number;
  longestSilentMs: number;
  analysisWindows: number;
  silentWindows: number;
  intervalHistogram: number[];
  intervalLabels: string[];
  durationHistogram: number[];
  durationLabels: string[];
  panHistogram: number[];
  positionHistogram: number[];
  recentRms: number[];
  activeHistory: number[];
  grains: GrainView[];
  scope: number[];
  recordFrames: number;
  recordActive: boolean;
  recordSeconds: number;
  callbackErrors: number;
  recordDropped: boolean;
  /** Forensic telemetry: most recent spawned grain records (newest last). */
  grainEvents: GrainEvent[];
  /** Current diagnostic switch state. */
  diagnostic: DiagnosticFlags;
  /** First frame where live output diverges from the independent window sum. */
  mixMismatch: MixMismatch | null;
  /** Instances silenced or phase-shifted through the diagnostic workbench. */
  mutedInstances: number[];
  phaseOffsets: { instance: number; offsetFrames: number }[];
  /** Count of extra grains produced by the double-trigger fault. */
  duplicateSpawns: number;
  /** Count of source reads that reached or crossed the final source sample. */
  endReachedReads: number;
}

export const INTERVAL_LABELS = ['0-2', '2-5', '5-10', '10-20', '20-50', '50-100', '100+'];
export const INTERVAL_EDGES = [0, 2, 5, 10, 20, 50, 100, Infinity];
export const DURATION_LABELS = ['<10', '10-25', '25-50', '50-100', '100-200', '200-400', '400+'];
export const DURATION_EDGES = [0, 10, 25, 50, 100, 200, 400, Infinity];
export const PAN_BINS = 9;
export const POSITION_BINS = 10;

export const DEFAULT_PARAMS: GrainParams = {
  density: 24,
  grainDuration: 0.12,
  durationJitter: 0.28,
  readSpeed: 1,
  speedJitter: 0.06,
  position: 0.35,
  positionJitter: 0.05,
  spread: 0.65,
  boundary: 'clip',
  amplitude: 0.42,
  masterGain: 1,
  seed: 0x51c0ffee,
};

export type MaterialId = 'impulse' | 'steady' | 'transient';

export const MATERIAL_LABELS: Record<MaterialId, string> = {
  impulse: '脉冲 IMPULSE',
  steady: '稳定音 STEADY',
  transient: '短瞬态 TRANSIENT',
};
