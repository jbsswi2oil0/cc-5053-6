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
