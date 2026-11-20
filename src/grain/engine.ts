import {
  DEFAULT_DIAGNOSTIC_FLAGS,
  DEFAULT_PARAMS,
  DURATION_EDGES,
  DURATION_LABELS,
  DiagnosticFlags,
  GrainEvent,
  GrainParams,
  GrainStats,
  GrainView,
  INTERVAL_EDGES,
  INTERVAL_LABELS,
  MixMismatch,
  PAN_BINS,
  POSITION_BINS,
} from './types';

import { FADE_SECONDS, windowAt } from './window';

export const ENGINE_LIMITS = {
  maxActive: 220,
  maxSpawnPerSecond: 1600,
  minSpawnIntervalMs: 0.5,
  maxGrainSeconds: 2,
  minGrainSeconds: 0.005,
  recordSeconds: 60,
  maxDensity: 400,
  limiterThreshold: 0.89,
} as const;

const STATS_INTERVAL_SECONDS = 1 / 30;
const RMS_WINDOW_SECONDS = 0.01;
const SILENT_RING_SECONDS = 20;
const HISTORY_INTERVAL_SECONDS = 0.025;
const RMS_HISTORY_LENGTH = 240;
const SCOPE_DECIMATION = 4;
const SCOPE_LENGTH = 512;
const SILENCE_RMS = 0.001;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sanitizeParams(raw: Partial<GrainParams> | undefined, base: GrainParams): GrainParams {
  if (!raw) return { ...base };
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
  return {
    density: num(raw.density, base.density, 0.2, ENGINE_LIMITS.maxDensity),
    grainDuration: num(raw.grainDuration, base.grainDuration, ENGINE_LIMITS.minGrainSeconds, ENGINE_LIMITS.maxGrainSeconds),
    durationJitter: num(raw.durationJitter, base.durationJitter, 0, 0.9),
    readSpeed: num(raw.readSpeed, base.readSpeed, 0.05, 8),
    speedJitter: num(raw.speedJitter, base.speedJitter, 0, 0.9),
    position: num(raw.position, base.position, 0, 1),
    positionJitter: num(raw.positionJitter, base.positionJitter, 0, 1),
    spread: num(raw.spread, base.spread, 0, 1),
    boundary: raw.boundary === 'loop' ? 'loop' : 'clip',
    amplitude: num(raw.amplitude, base.amplitude, 0, 1),
    masterGain: num(raw.masterGain, base.masterGain, 0, 1),
    seed: num(raw.seed, base.seed, 0, 0xffffffff) >>> 0,
  };
}

export class GrainEngine {
  private sampleRate = 48000;
  private params: GrainParams = { ...DEFAULT_PARAMS };
  private rand = mulberry32(DEFAULT_PARAMS.seed);

  private source: Float32Array | null = null;
  private sourceName = '—';
  private sourceRate = 48000;

  private playing = false;
  private paused = false;
  private fade = 0;
  private fadeTarget = 0;
  private fadeStep = 0;

  private frame = 0;
  private playFrame = 0;
  private nextSpawnFrame = 0;
  private spawnCount = 0;
  private epochSpawnCount = 0;
  private lastSpawnPlayFrame = -1;
  private dropped = 0;
  private boundaryTruncated = 0;
  private boundarySkipped = 0;
  private loopWraps = 0;
  private outOfRangeReads = 0;
  private nanSamples = 0;
  private windowEdgeMax = 0;
  private readPosMin = Infinity;
  private readPosMax = -Infinity;
  private peak = 0;
  private densityPeak = 0;
  private densityActivePeak = 0;
  private rmsAccum = 0;
  private rmsFrames = 0;
  private callbackErrors = 0;
  private limiterMaxReductionDb = 0;
  private limiterEngagedFrames = 0;
  private limiterGain = 1;
  private normGain = 1;

  private statsCounter = 0;

  private active = 0;
  private peakActive = 0;
  private readonly capacity = ENGINE_LIMITS.maxActive;
  private readonly gPos = new Float64Array(this.capacity);
  private readonly gStart = new Float64Array(this.capacity);
  private readonly gLen = new Int32Array(this.capacity);
  private readonly gAge = new Int32Array(this.capacity);
  private readonly gRate = new Float64Array(this.capacity);
  private readonly gGainL = new Float64Array(this.capacity);
  private readonly gGainR = new Float64Array(this.capacity);
  private readonly gId = new Uint32Array(this.capacity);
  private readonly gPan = new Float64Array(this.capacity);
  private readonly gDur = new Float64Array(this.capacity);
  private readonly gInstance = new Uint32Array(this.capacity);
  private readonly gPhaseOffset = new Float64Array(this.capacity);
  private readonly gMuted = new Uint8Array(this.capacity);
  private readonly gDuplicate = new Uint8Array(this.capacity);
  private readonly gTruncated = new Uint8Array(this.capacity);
  private nextGrainId = 1;
  private nextInstance = 1;

  private diagnostic: DiagnosticFlags = { ...DEFAULT_DIAGNOSTIC_FLAGS };
  private frozenRandState: number | null = null;
  private duplicateSpawns = 0;
  private endReachedReads = 0;
  private mutedInstances = new Set<number>();
  private phaseOffsetByInstance = new Map<number, number>();

  /** Forensic ledger: one entry per spawned grain, ring-buffered. */
  private readonly eventCapacity = 16384;
  private readonly eventRing: GrainEvent[] = [];
  private eventRingStart = 0;
  private eventRingCount = 0;

  /** Independent per-frame window-sum reference, kept only while diagnosing. */
  private mismatch: MixMismatch | null = null;
  private diagnosing = false;

  private readonly intervalHistogram = new Array(INTERVAL_LABELS.length).fill(0);
  private readonly durationHistogram = new Array(DURATION_LABELS.length).fill(0);
  private readonly panHistogram = new Array(PAN_BINS).fill(0);
  private readonly positionHistogram = new Array(POSITION_BINS).fill(0);

  /** Spawn timestamps (engine frames) used to measure real density over a window. */
  private spawnTimes = new Float64Array(16384);
  private spawnTimeIndex = 0;
  private spawnTimeCount = 0;

  private rmsHistory: number[] = [];
  private activeHistory: number[] = [];
  private historyAccumFrames = 0;
  private historySumSq = 0;
  private historyRmsFrames = 0;

  private continuityWindowFrames = 0;
  private continuitySumSq = 0;
  private silentRing: Uint8Array;
  private silentRingIndex = 0;
  private silentRingCount = 0;
  private silentRingSum = 0;
  private longestSilentMs = 0;

  private scopeL = new Float64Array(SCOPE_LENGTH);
  private scopeR = new Float64Array(SCOPE_LENGTH);
  private scopeIndex = 0;
  private scopeDecimator = 0;

  private readonly recordCapacityFrames: number;
  private recordLeft: Float32Array | null = null;
  private recordRight: Float32Array | null = null;
  private recordWritten = 0;
  private recordSent = 0;
  private recordActive = false;
  private recordDropped = false;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.recordCapacityFrames = Math.floor(ENGINE_LIMITS.recordSeconds * sampleRate);
    this.silentRing = new Uint8Array(Math.ceil(SILENT_RING_SECONDS / RMS_WINDOW_SECONDS));
    this.applyFadeRates();
  }

  private applyFadeRates(): void {
    this.fadeStep = 1 / (FADE_SECONDS * this.sampleRate);
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  setSampleRate(sampleRate: number): void {
    if (sampleRate === this.sampleRate) return;
    this.sampleRate = sampleRate;
    this.applyFadeRates();
  }

  setSource(samples: Float32Array, sampleRate: number, name: string): void {
    this.source = samples;
    this.sourceRate = sampleRate;
    this.sourceName = name;
    this.active = 0;
    this.peakActive = 0;
    this.readPosMin = Infinity;
    this.readPosMax = -Infinity;
    if (!this.playing) this.nextSpawnFrame = this.frame;
  }

  clearSource(): void {
    this.source = null;
    this.sourceName = '—';
    this.active = 0;
    this.playing = false;
    this.paused = false;
    this.fade = 0;
    this.fadeTarget = 0;
    this.recordActive = false;
  }

  setParams(raw: Partial<GrainParams>): void {
    const prev = this.params;
    const next = sanitizeParams(raw, this.params);
    if (next.density !== prev.density && this.playing && this.nextSpawnFrame > this.frame) {
      const remaining = this.nextSpawnFrame - this.frame;
      this.nextSpawnFrame = this.frame + (remaining * prev.density) / next.density;
    }
    if (next.density !== prev.density) {
      this.densityPeak = 0;
      this.densityActivePeak = 0;
    }
    const epochChanged =
      next.density !== prev.density ||
      next.grainDuration !== prev.grainDuration ||
      next.durationJitter !== prev.durationJitter ||
      next.readSpeed !== prev.readSpeed ||
      next.speedJitter !== prev.speedJitter ||
      next.position !== prev.position ||
      next.positionJitter !== prev.positionJitter ||
      next.spread !== prev.spread ||
      next.boundary !== prev.boundary ||
      next.amplitude !== prev.amplitude ||
      next.seed !== prev.seed;
    this.params = next;
    if (next.seed !== prev.seed) this.rand = mulberry32(next.seed);
    if (epochChanged) this.resetAnalysisEpoch();
  }

  getParams(): GrainParams {
    return { ...this.params };
  }

  getDiagnosticFlags(): DiagnosticFlags {
    return { ...this.diagnostic };
  }

  setDiagnosticFlags(patch: Partial<DiagnosticFlags>): void {
    const prev = this.diagnostic;
    this.diagnostic = { ...prev, ...patch };
    if (this.diagnostic.seedFrozen && !prev.seedFrozen) {
      // Capture the live PRNG state: mulberry32's state is the seed it was last
      // (re)initialised with plus the number of draws, so snapshot via params seed
      // and let play() rewind; also remember the current numeric state directly.
      this.frozenRandState = this.params.seed >>> 0;
    }
    if (!this.diagnostic.seedFrozen) this.frozenRandState = null;
    if (this.diagnosing) this.mismatch = null;
  }

  /** Stops an already spawned (or future) instance from contributing to output. */
  muteInstance(instance: number): void {
    this.mutedInstances.add(instance);
    for (let g = 0; g < this.active; g++) {
      if (this.gInstance[g] === instance) this.gMuted[g] = 1;
    }
    for (const ev of this.eventRing) {
      if (ev.instance === instance) ev.muted = true;
    }
  }

  unmuteInstance(instance: number): void {
    this.mutedInstances.delete(instance);
    for (let g = 0; g < this.active; g++) {
      if (this.gInstance[g] === instance) this.gMuted[g] = 0;
    }
    for (const ev of this.eventRing) {
      if (ev.instance === instance) ev.muted = false;
    }
  }

  isInstanceMuted(instance: number): boolean {
    return this.mutedInstances.has(instance);
  }

  /** Shifts the source read position of one instance by a signed frame offset. */
  setInstancePhase(instance: number, offsetFrames: number): void {
    if (!Number.isFinite(offsetFrames)) return;
    this.phaseOffsetByInstance.set(instance, offsetFrames);
    for (let g = 0; g < this.active; g++) {
      if (this.gInstance[g] === instance) this.gPhaseOffset[g] = offsetFrames;
    }
    for (const ev of this.eventRing) {
      if (ev.instance === instance) ev.phaseOffset = offsetFrames;
    }
  }

  clearInstancePhase(instance: number): void {
    this.phaseOffsetByInstance.delete(instance);
    for (let g = 0; g < this.active; g++) {
      if (this.gInstance[g] === instance) this.gPhaseOffset[g] = 0;
    }
    for (const ev of this.eventRing) {
      if (ev.instance === instance) ev.phaseOffset = 0;
    }
  }

  getInstancePhase(instance: number): number {
    return this.phaseOffsetByInstance.get(instance) ?? 0;
  }

  /** Returns the forensic ledger, newest events last. */
  getGrainEvents(): GrainEvent[] {
    const out: GrainEvent[] = [];
    for (let i = 0; i < this.eventRingCount; i++) {
      out.push(this.eventRing[(this.eventRingStart + i) % this.eventCapacity]);
    }
    return out;
  }

  getMutedInstances(): number[] {
    return [...this.mutedInstances].sort((a, b) => a - b);
  }

  getPhaseOffsets(): { instance: number; offsetFrames: number }[] {
    return [...this.phaseOffsetByInstance.entries()]
      .map(([instance, offsetFrames]) => ({ instance, offsetFrames }))
      .sort((a, b) => a.instance - b.instance);
  }

  getMixMismatch(): MixMismatch | null {
    return this.mismatch;
  }

  /** Enables the independent per-frame window-sum reference and mismatch scan. */
  startDiagnosis(): void {
    this.diagnosing = true;
    this.mismatch = null;
  }

  stopDiagnosis(): void {
    this.diagnosing = false;
  }

  isDiagnosing(): boolean {
    return this.diagnosing;
  }

  play(): void {
    if (!this.source) return;
    this.resetSession();
    if (this.diagnostic.seedFrozen) {
      const frozen = this.frozenRandState ?? this.params.seed;
      this.rand = mulberry32(frozen >>> 0);
    }
    this.playing = true;
    this.paused = false;
    this.fade = 0;
    this.fadeTarget = 1;
    this.nextSpawnFrame = this.frame;
  }

  stop(): void {
    this.fadeTarget = 0;
    this.paused = false;
  }

  pause(): void {
    if (!this.playing || this.paused) return;
    this.paused = true;
    this.fadeTarget = 0;
  }

  resume(): void {
    if (!this.playing || !this.paused) return;
    this.paused = false;
    this.fadeTarget = 1;
    this.nextSpawnFrame = this.frame + this.sampleRate / this.params.density;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isPaused(): boolean {
    return this.paused;
  }

  startRecording(): boolean {
    if (!this.playing) return false;
    if (!this.recordLeft) {
      this.recordLeft = new Float32Array(this.recordCapacityFrames);
      this.recordRight = new Float32Array(this.recordCapacityFrames);
    }
    this.recordWritten = 0;
    this.recordSent = 0;
    this.recordDropped = false;
    this.recordActive = true;
    return true;
  }

  stopRecording(): void {
    this.recordActive = false;
  }

  isRecording(): boolean {
    return this.recordActive;
  }

  /** Returns audio recorded since the last drain. The UI flushes this on its own schedule. */
  drainRecorded(): { left: Float32Array; right: Float32Array; frames: number; dropped: boolean } | null {
    if (!this.recordLeft || !this.recordRight) return null;
    const n = this.recordWritten - this.recordSent;
    if (n <= 0) return null;
    const left = this.recordLeft.slice(this.recordSent, this.recordWritten);
    const right = this.recordRight.slice(this.recordSent, this.recordWritten);
    this.recordSent = this.recordWritten;
    const dropped = this.recordDropped;
    this.recordDropped = false;
    return { left, right, frames: n, dropped };
  }

  getRecordTotalFrames(): number {
    return this.recordWritten;
  }

  /** Clears "current setting" analysis while leaving safety counters cumulative. */
  private resetAnalysisEpoch(): void {
    this.epochSpawnCount = 0;
    this.lastSpawnPlayFrame = -1;
    this.intervalHistogram.fill(0);
    this.durationHistogram.fill(0);
    this.panHistogram.fill(0);
    this.positionHistogram.fill(0);
    this.spawnTimeIndex = 0;
    this.spawnTimeCount = 0;
    this.silentRing.fill(0);
    this.silentRingIndex = 0;
    this.silentRingCount = 0;
    this.silentRingSum = 0;
    this.longestSilentMs = 0;
    this.continuityWindowFrames = 0;
    this.continuitySumSq = 0;
    this.peak = 0;
    this.densityPeak = 0;
    this.densityActivePeak = 0;
  }

  private resetSession(): void {
    this.spawnCount = 0;
    this.epochSpawnCount = 0;
    this.lastSpawnPlayFrame = -1;
    this.dropped = 0;
    this.boundaryTruncated = 0;
    this.boundarySkipped = 0;
    this.loopWraps = 0;
    this.outOfRangeReads = 0;
    this.nanSamples = 0;
    this.windowEdgeMax = 0;
    this.peak = 0;
    this.densityPeak = 0;
    this.densityActivePeak = 0;
    this.rmsAccum = 0;
    this.rmsFrames = 0;
    this.callbackErrors = 0;
    this.limiterMaxReductionDb = 0;
    this.limiterEngagedFrames = 0;
    this.limiterGain = 1;
    this.peakActive = 0;
    this.intervalHistogram.fill(0);
    this.durationHistogram.fill(0);
    this.panHistogram.fill(0);
    this.positionHistogram.fill(0);
    this.spawnTimeIndex = 0;
    this.spawnTimeCount = 0;
    this.rmsHistory = [];
    this.activeHistory = [];
    this.historyAccumFrames = 0;
    this.historySumSq = 0;
    this.historyRmsFrames = 0;
    this.continuityWindowFrames = 0;
    this.continuitySumSq = 0;
    this.silentRing.fill(0);
    this.silentRingIndex = 0;
    this.silentRingCount = 0;
    this.silentRingSum = 0;
    this.longestSilentMs = 0;
    this.scopeIndex = 0;
    this.scopeDecimator = 0;
    this.statsCounter = 0;
    this.playFrame = 0;
    this.readPosMin = Infinity;
    this.readPosMax = -Infinity;
    this.recordWritten = 0;
    this.recordSent = 0;
    this.recordDropped = false;
    this.duplicateSpawns = 0;
    this.endReachedReads = 0;
    this.mismatch = null;
    this.eventRing.length = 0;
    this.eventRingStart = 0;
    this.eventRingCount = 0;
    this.nextInstance = 1;
    this.mutedInstances.clear();
    this.phaseOffsetByInstance.clear();
    if (this.diagnostic.seedFrozen && this.frozenRandState !== null) {
      this.rand = mulberry32(this.frozenRandState);
    }
  }

  /** Power normalisation: energy stays bounded as overlapping grain count grows. */
  private computeNorm(): void {
    const overlap = this.params.density * this.params.grainDuration;
    this.normGain = 1 / Math.sqrt(Math.max(0.75, overlap));
  }

  private pushGrainEvent(ev: GrainEvent): void {
    if (this.eventRingCount < this.eventCapacity) {
      this.eventRing.push(ev);
      this.eventRingCount++;
    } else {
      this.eventRing[this.eventRingStart] = ev;
      this.eventRingStart = (this.eventRingStart + 1) % this.eventCapacity;
    }
  }

  private spawnGrain(committedFrame: number): boolean {
    const src = this.source;
    if (!src || src.length < 4) return false;
    const p = this.params;
    const sr = this.sampleRate;
    const span = src.length - 1;

    const dur = clamp(
      p.grainDuration * (1 + p.durationJitter * (this.rand() * 2 - 1)),
      ENGINE_LIMITS.minGrainSeconds,
      ENGINE_LIMITS.maxGrainSeconds,
    );
    const rate = clamp(p.readSpeed * (1 + p.speedJitter * (this.rand() * 2 - 1)), 0.05, 8);
    let len = Math.max(4, Math.round(dur * sr));
    let truncated = false;

    const required = (len - 1) * rate;
    if (required > span) {
      if (p.boundary === 'clip' && this.diagnostic.fixSourceOverrun) {
        len = Math.floor(span / rate) + 1;
        if (len < 4) {
          this.boundarySkipped++;
          return false;
        }
        truncated = true;
        this.boundaryTruncated++;
      }
    }

    const maxStart =
      p.boundary === 'clip' && this.diagnostic.fixSourceOverrun
        ? Math.max(0, span - (len - 1) * rate)
        : Math.max(0, span);
    const center = p.position * maxStart;
    const jitter = p.positionJitter * maxStart;
    let start = clamp(center + (this.rand() * 2 - 1) * jitter, 0, maxStart);
    start = Math.round(start);
    if (
      p.boundary === 'clip' &&
      this.diagnostic.fixSourceOverrun &&
      start + (len - 1) * rate > span + 1e-6
    ) {
      start = Math.floor(maxStart);
    }

    if (this.active >= this.capacity) {
      this.dropped++;
      return false;
    }

    const pan = p.spread * (this.rand() * 2 - 1);
    const angle = ((pan + 1) * Math.PI) / 4;
    const gain = p.amplitude * this.normGain;
    const instance = this.nextInstance++;
    const committed = this.commitGrain(
      instance,
      start,
      len,
      rate,
      pan,
      gain,
      truncated,
      false,
      src.length,
      committedFrame,
    );

    // Double-trigger fault: the same grain parameters are submitted a second
    // time under the same instance number so telemetry exposes the duplication.
    if (committed && this.diagnostic.injectDoubleTrigger && this.active < this.capacity) {
      this.commitGrain(instance, start, len, rate, pan, gain, truncated, true, src.length, committedFrame);
      this.duplicateSpawns++;
    }
    return committed;
  }

  private commitGrain(
    instance: number,
    start: number,
    len: number,
    rate: number,
    pan: number,
    gain: number,
    truncated: boolean,
    duplicate: boolean,
    sourceLength: number,
    committedFrame: number,
  ): boolean {
    const phaseOffset = this.phaseOffsetByInstance.get(instance) ?? 0;
    const muted = this.mutedInstances.has(instance) ? 1 : 0;
    const slot = this.active;
    this.gPos[slot] = start;
    this.gStart[slot] = start;
    this.gLen[slot] = len;
    this.gAge[slot] = 0;
    this.gRate[slot] = rate;
    this.gGainL[slot] = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    this.gGainR[slot] = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    this.gId[slot] = this.nextGrainId++;
    this.gPan[slot] = pan;
    this.gDur[slot] = len / this.sampleRate;
    this.gInstance[slot] = instance;
    this.gPhaseOffset[slot] = phaseOffset;
    this.gMuted[slot] = muted;
    this.gDuplicate[slot] = duplicate ? 1 : 0;
    this.gTruncated[slot] = truncated ? 1 : 0;
    this.active++;
    if (this.active > this.peakActive) this.peakActive = this.active;
    if (this.active > this.densityActivePeak) this.densityActivePeak = this.active;

    this.pushGrainEvent({
      instance,
      id: this.gId[slot],
      spawnFrame: committedFrame,
      sourceStart: start,
      sourceEnd: start + (len - 1) * rate,
      sourceLength,
      length: len,
      rate,
      windowPhaseStart: 0,
      windowPhaseEnd: 1,
      pan,
      gainL: this.gGainL[slot],
      gainR: this.gGainR[slot],
      normGain: this.normGain,
      truncated,
      duplicate,
      phaseOffset,
      muted: muted === 1,
    });

    if (!duplicate) {
      this.spawnCount++;
      this.epochSpawnCount++;
      if (this.lastSpawnPlayFrame >= 0) {
        const intervalMs = ((committedFrame - this.lastSpawnPlayFrame) / this.sampleRate) * 1000;
        this.intervalHistogram[this.binIndex(INTERVAL_EDGES, intervalMs)]++;
      }
      this.lastSpawnPlayFrame = committedFrame;
      this.spawnTimes[this.spawnTimeIndex] = committedFrame;
      this.spawnTimeIndex = (this.spawnTimeIndex + 1) % this.spawnTimes.length;
      this.spawnTimeCount++;

      this.durationHistogram[this.binIndex(DURATION_EDGES, this.gDur[slot] * 1000)]++;
      this.panHistogram[Math.min(PAN_BINS - 1, Math.floor(((pan + 1) / 2) * PAN_BINS))]++;
      this.positionHistogram[
        Math.min(POSITION_BINS - 1, Math.floor((start / Math.max(1, sourceLength - 1)) * POSITION_BINS))
      ]++;
    }
    return true;
  }

  private binIndex(edges: number[], value: number): number {
    for (let i = 0; i < edges.length - 1; i++) {
      if (value < edges[i + 1]) return i;
    }
    return edges.length - 2;
  }

  private scheduleNextSpawn(): void {
    const sr = this.sampleRate;
    const jittered = (sr / this.params.density) * (1 + (this.rand() * 2 - 1) * 0.12);
    const minInterval = (ENGINE_LIMITS.minSpawnIntervalMs / 1000) * sr;
    const capInterval = sr / ENGINE_LIMITS.maxSpawnPerSecond;
    // Both limits are minimum spacings (a sub-frame floor and the per-second
    // spawn cap); the scheduled interval is the desired spacing widened to them.
    this.nextSpawnFrame += Math.max(minInterval, capInterval, jittered);
  }

  private removeGrain(g: number): void {
    const last = this.active - 1;
    if (g !== last) {
      this.gPos[g] = this.gPos[last];
      this.gLen[g] = this.gLen[last];
      this.gAge[g] = this.gAge[last];
      this.gRate[g] = this.gRate[last];
      this.gGainL[g] = this.gGainL[last];
      this.gGainR[g] = this.gGainR[last];
      this.gId[g] = this.gId[last];
      this.gStart[g] = this.gStart[last];
      this.gPan[g] = this.gPan[last];
      this.gDur[g] = this.gDur[last];
      this.gInstance[g] = this.gInstance[last];
      this.gPhaseOffset[g] = this.gPhaseOffset[last];
      this.gMuted[g] = this.gMuted[last];
      this.gDuplicate[g] = this.gDuplicate[last];
      this.gTruncated[g] = this.gTruncated[last];
    }
    this.active--;
  }

  private windowAt(age: number, len: number): number {
    return windowAt(age, len);
  }

  private readSource(pos: number, loop: boolean, srcLen: number): number {
    if (pos < 0) {
      this.outOfRangeReads++;
      pos = 0;
    }
    if (pos > srcLen - 1) {
      if (loop) {
        pos -= Math.floor(pos / srcLen) * srcLen;
        this.loopWraps++;
      } else {
        this.outOfRangeReads++;
        pos = srcLen - 1;
      }
    }
    const i0 = pos | 0;
    const frac = pos - i0;
    let i1 = i0 + 1;
    if (i1 >= srcLen) i1 = loop ? 0 : srcLen - 1;
    const s = this.source![i0] + (this.source![i1] - this.source![i0]) * frac;
    if (!Number.isFinite(s)) {
      this.nanSamples++;
      return 0;
    }
    if (i0 >= srcLen - 1) this.endReachedReads++;
    return s;
  }

  private renderRange(outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    const src = this.source;
    if (!src || this.active === 0) {
      for (let n = from; n < to; n++) {
        outL[n] = 0;
        outR[n] = 0;
      }
      return;
    }
    const srcLen = src.length;
    const loop = this.params.boundary === 'loop';
    const injectNormError = this.diagnostic.injectWindowNormError;
    const fixWindowMix = this.diagnostic.fixWindowMix;
    const allowOverrun = this.diagnostic.injectSourceOverrun && !this.diagnostic.fixSourceOverrun;

    for (let n = from; n < to; n++) {
      let sumL = 0;
      let sumR = 0;
      let g = 0;
      while (g < this.active) {
        const len = this.gLen[g];
        const age = this.gAge[g];
        const w = this.windowAt(age, len);
        if (age === 0 || age === len - 1) {
          if (w > this.windowEdgeMax) this.windowEdgeMax = w;
        }

        const rawPos = this.gPos[g] + this.gPhaseOffset[g];
        const overran = rawPos > srcLen - 1 || rawPos < 0;
        let s: number;
        let trackedPos: number;
        if (overran && allowOverrun && !loop) {
          // Fault path: the read crosses the source end without truncation. The
          // out-of-bounds region reads as silence instead of a held last sample.
          this.outOfRangeReads++;
          if (rawPos > srcLen - 1) this.endReachedReads++;
          s = 0;
          trackedPos = Math.max(0, Math.min(rawPos, srcLen - 1));
        } else {
          s = this.readSource(rawPos, loop, srcLen);
          trackedPos = rawPos > srcLen - 1 ? srcLen - 1 : rawPos < 0 ? 0 : rawPos;
        }
        if (trackedPos < this.readPosMin) this.readPosMin = trackedPos;
        if (trackedPos > this.readPosMax) this.readPosMax = trackedPos;

        if (!this.gMuted[g]) {
          let mixW: number;
          if (fixWindowMix) {
            mixW = w;
          } else if (injectNormError) {
            // Window-normalisation fault: gain is divided by the window value,
            // flattening every envelope and piling energy into overlap tails.
            mixW = 1 / Math.max(0.25, w);
          } else {
            mixW = w;
          }
          sumL += s * this.gGainL[g] * mixW;
          sumR += s * this.gGainR[g] * mixW;
        }

        this.gPos[g] = this.gPos[g] + this.gRate[g];
        this.gAge[g] = age + 1;
        if (age + 1 >= len) {
          this.removeGrain(g);
          continue;
        }
        g++;
      }
      outL[n] += sumL;
      outR[n] += sumR;
    }
  }

  /**
   * Scans the whole quantum against the independent reference before rendering.
   * Runs once per process() call so block-internal renderRange splits and the
   * later fade/limiter stages cannot hide a divergence.
   */
  private snapshotGrains(): {
    id: number;
    instance: number;
    pos: number;
    age: number;
    len: number;
    rate: number;
    gainL: number;
    phase: number;
    muted: boolean;
  }[] {
    const out = [];
    for (let g = 0; g < this.active; g++) {
      out.push({
        id: this.gId[g],
        instance: this.gInstance[g],
        pos: this.gPos[g],
        age: this.gAge[g],
        len: this.gLen[g],
        rate: this.gRate[g],
        gainL: this.gGainL[g],
        phase: this.gPhaseOffset[g],
        muted: this.gMuted[g] === 1,
      });
    }
    return out;
  }

  private scanReferenceQuantum(
    frames: number,
    snapshot: {
      from: number;
      to: number;
      grains: {
        id: number;
        instance: number;
        startPos: number;
        startAge: number;
        endPos: number;
        endAge: number;
        len: number;
        rate: number;
        gainL: number;
        phase: number;
        muted: boolean;
      }[];
    },
    rangeOffset: number,
  ): void {
    if (!this.diagnosing || this.mismatch || !this.source) return;
    const faultActive =
      (this.diagnostic.injectSourceOverrun && !this.diagnostic.fixSourceOverrun) ||
      (!this.diagnostic.fixWindowMix && this.diagnostic.injectWindowNormError);
    const fadeOpen = this.fade >= 1 && this.fadeTarget >= 1;
    if (!faultActive && !fadeOpen) return;

    const live = new Float64Array(frames);
    const reference = new Float64Array(frames);
    const activeByFrame: number[][] = new Array(frames);

    for (let n = 0; n < frames; n++) {
      const activeAtFrame: number[] = [];
      let liveSum = 0;
      let refSum = 0;
      for (const gr of snapshot.grains) {
        const age = gr.startAge + n;
        if (age < 0 || age >= gr.len) continue;
        const w = this.windowAt(age, gr.len);
        const basePos = gr.startPos + n * gr.rate + gr.phase;
        const srcLen = this.source.length;
        const loop = this.params.boundary === 'loop';

        if (gr.muted) continue;

        // Reference: always clamped/looped, correct multiplicative Hann window.
        let refPos = basePos;
        if (refPos > srcLen - 1) refPos = loop ? refPos % srcLen : srcLen - 1;
        else if (refPos < 0) refPos = 0;
        const ri0 = refPos | 0;
        const rf = refPos - ri0;
        let ri1 = ri0 + 1;
        if (ri1 >= srcLen) ri1 = loop ? 0 : srcLen - 1;
        const rs = this.source[ri0] + (this.source[ri1] - this.source[ri0]) * rf;
        refSum += rs * gr.gainL * w;

        activeAtFrame.push(gr.instance);

        // Live path under the currently configured switches/faults.
        let s: number;
        let mixW: number;
        const overran = basePos > srcLen - 1 || basePos < 0;
        if (overran && this.diagnostic.injectSourceOverrun && !this.diagnostic.fixSourceOverrun && !loop) {
          s = 0;
        } else {
          let p = basePos;
          if (p > srcLen - 1) p = loop ? p % srcLen : srcLen - 1;
          else if (p < 0) p = 0;
          const i0 = p | 0;
          const frac = p - i0;
          let i1 = i0 + 1;
          if (i1 >= srcLen) i1 = loop ? 0 : srcLen - 1;
          s = this.source[i0] + (this.source[i1] - this.source[i0]) * frac;
        }
        if (this.diagnostic.fixWindowMix) mixW = w;
        else if (this.diagnostic.injectWindowNormError) mixW = 1 / Math.max(0.25, w);
        else mixW = w;
        liveSum += s * gr.gainL * mixW;
      }
      live[n] = liveSum;
      reference[n] = refSum;
      activeByFrame[n] = activeAtFrame;
    }

    const master = this.params.masterGain;
    let simFade = this.fade;
    for (let n = 0; n < frames; n++) {
      // Healthy comparison includes the same fade/master envelope the live path
      // applies after rendering; fault scans compare raw sums so any divergence is
      // attributable to the injected stage rather than the global envelope.
      if (!faultActive) {
        if (simFade < this.fadeTarget) simFade = Math.min(this.fadeTarget, simFade + this.fadeStep);
        else if (simFade > this.fadeTarget) simFade = Math.max(this.fadeTarget, simFade - this.fadeStep);
        reference[n] *= master * simFade;
        live[n] *= master * simFade;
      }
      const delta = Math.abs(live[n] - reference[n]);
      // Fault paths use a tight absolute threshold. Healthy comparisons ignore the
      // first frame of each render range (where a grain may spawn mid-quantum) and
      // otherwise tolerate relative floating-point/ordering noise.
      const atRangeEdge = n === 0;
      const threshold = faultActive ? 2e-3 : Math.max(1e-3, Math.abs(reference[n]) * 0.05);
      if (!atRangeEdge && delta > threshold) {
        let stage: MixMismatch['attributedStage'] = 'unknown';
        if (this.diagnostic.injectSourceOverrun && !this.diagnostic.fixSourceOverrun) {
          stage = 'source-overrun';
        } else if (!this.diagnostic.fixWindowMix && this.diagnostic.injectWindowNormError) {
          stage = 'window-mix';
        }
        this.mismatch = {
          frame: this.frame + rangeOffset + n,
          delta,
          live: live[n],
          reference: reference[n],
          activeInstances: activeByFrame[n],
          attributedStage: stage,
        };
        return;
      }
    }
  }

  private applyFadeAndMaster(outL: Float32Array, outR: Float32Array, frames: number): void {
    const master = this.params.masterGain;
    for (let n = 0; n < frames; n++) {
      if (this.fade < this.fadeTarget) {
        this.fade = Math.min(this.fadeTarget, this.fade + this.fadeStep);
      } else if (this.fade > this.fadeTarget) {
        this.fade = Math.max(this.fadeTarget, this.fade - this.fadeStep);
      }
      outL[n] *= master * this.fade;
      outR[n] *= master * this.fade;
    }
  }

  private applyLimiter(outL: Float32Array, outR: Float32Array, frames: number): void {
    const thresh = ENGINE_LIMITS.limiterThreshold;
    const release = Math.exp(-1 / (0.12 * this.sampleRate));
    let engaged = 0;
    let minGain = 1;
    for (let n = 0; n < frames; n++) {
      const peak = Math.max(Math.abs(outL[n]), Math.abs(outR[n]));
      const desired = peak > thresh ? thresh / peak : 1;
      if (desired < this.limiterGain) this.limiterGain = desired;
      else this.limiterGain = 1 + (this.limiterGain - 1) * release;
      if (this.limiterGain < 0.9999) engaged++;
      if (this.limiterGain < minGain) minGain = this.limiterGain;
      outL[n] = clamp(outL[n] * this.limiterGain, -0.985, 0.985);
      outR[n] = clamp(outR[n] * this.limiterGain, -0.985, 0.985);
    }
    this.limiterEngagedFrames += engaged;
    if (minGain < 1) {
      const db = 20 * Math.log10(Math.max(1e-6, minGain));
      if (db < this.limiterMaxReductionDb) this.limiterMaxReductionDb = db;
    }
  }

  private trackAnalysis(outL: Float32Array, outR: Float32Array, frames: number): void {
    let peak = 0;
    let sumSq = 0;
    for (let n = 0; n < frames; n++) {
      const l = outL[n];
      const r = outR[n];
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      sumSq += (l * l + r * r) * 0.5;
      if ((this.scopeDecimator++ & (SCOPE_DECIMATION - 1)) === 0) {
        this.scopeL[this.scopeIndex] = l;
        this.scopeR[this.scopeIndex] = r;
        this.scopeIndex = (this.scopeIndex + 1) % SCOPE_LENGTH;
      }
    }
    if (peak > this.peak) this.peak = peak;
    if (peak > this.densityPeak) this.densityPeak = peak;
    this.rmsAccum += sumSq;
    this.rmsFrames += frames;

    if (this.recordActive && this.recordLeft && this.recordRight) {
      const space = this.recordCapacityFrames - this.recordWritten;
      if (space < frames) this.recordDropped = true;
      const n = Math.min(space, frames);
      if (n > 0) {
        this.recordLeft.set(outL.subarray(0, n), this.recordWritten);
        this.recordRight.set(outR.subarray(0, n), this.recordWritten);
        this.recordWritten += n;
      }
      if (this.recordWritten >= this.recordCapacityFrames) this.recordActive = false;
    }

    this.continuityWindowFrames += frames;
    this.continuitySumSq += sumSq;
    const windowFrames = Math.max(1, Math.floor(RMS_WINDOW_SECONDS * this.sampleRate));
    if (this.continuityWindowFrames >= windowFrames) {
      if (this.playing && !this.paused) {
        const rms = Math.sqrt(this.continuitySumSq / this.continuityWindowFrames);
        this.pushSilentWindow(rms < SILENCE_RMS);
      }
      this.continuityWindowFrames = 0;
      this.continuitySumSq = 0;
    }

    this.historyAccumFrames += frames;
    this.historySumSq += sumSq;
    this.historyRmsFrames += frames;
    if (this.historyAccumFrames >= Math.floor(HISTORY_INTERVAL_SECONDS * this.sampleRate)) {
      this.rmsHistory.push(this.historyRmsFrames > 0 ? Math.sqrt(this.historySumSq / this.historyRmsFrames) : 0);
      this.activeHistory.push(this.active);
      if (this.rmsHistory.length > RMS_HISTORY_LENGTH) this.rmsHistory.shift();
      if (this.activeHistory.length > RMS_HISTORY_LENGTH) this.activeHistory.shift();
      this.historyAccumFrames = 0;
      this.historySumSq = 0;
      this.historyRmsFrames = 0;
    }
  }

  private pushSilentWindow(silent: boolean): void {
    if (this.silentRingCount >= this.silentRing.length) {
      this.silentRingSum -= this.silentRing[this.silentRingIndex];
    } else {
      this.silentRingCount++;
    }
    const v = silent ? 1 : 0;
    this.silentRing[this.silentRingIndex] = v;
    this.silentRingSum += v;
    this.silentRingIndex = (this.silentRingIndex + 1) % this.silentRing.length;
    if (silent) {
      let run = 0;
      for (let i = 0; i < this.silentRingCount; i++) {
        const idx = (this.silentRingIndex - 1 - i + this.silentRing.length) % this.silentRing.length;
        if (!this.silentRing[idx]) break;
        run++;
      }
      this.longestSilentMs = Math.max(this.longestSilentMs, run * RMS_WINDOW_SECONDS * 1000);
    }
  }

  /**
   * Renders one audio quantum. All scheduling is driven by the sample counter, so
   * the trigger grid is independent of quantum size, UI refresh and wall clock.
   */
  process(outL: Float32Array, outR: Float32Array): void {
    const frames = outL.length;
    outL.fill(0);
    outR.fill(0);
    this.computeNorm();

    if (this.playing) {
      const spawnAllowed = !this.paused && this.fadeTarget > 0;
      if (this.nextSpawnFrame < this.frame) this.nextSpawnFrame = this.frame;

      // Each render range records, per stable grain id, the read position/age at
      // both the first and last frame of the range. Keying by id makes the
      // reference immune to the slot swaps the pool performs when grains end.
      interface GrainFrameState {
        id: number;
        instance: number;
        startPos: number;
        startAge: number;
        endPos: number;
        endAge: number;
        len: number;
        rate: number;
        gainL: number;
        phase: number;
        muted: boolean;
      }
      interface RangeSnapshot {
        from: number;
        to: number;
        grains: GrainFrameState[];
      }
      const snapshots: RangeSnapshot[] = [];

      // Interleave spawning and rendering so each grain starts on its exact sample,
      // regardless of how many samples the host delivers per callback.
      let rendered = 0;
      while (rendered < frames) {
        if (spawnAllowed && this.source && this.frame + rendered >= this.nextSpawnFrame) {
          this.spawnGrain(this.frame + rendered);
          this.scheduleNextSpawn();
          continue;
        }
        let chunkEnd = frames;
        if (spawnAllowed && this.source) {
          const nextOffset = Math.ceil(this.nextSpawnFrame - this.frame);
          if (nextOffset > rendered) chunkEnd = Math.min(frames, nextOffset);
        }
        if (chunkEnd <= rendered) chunkEnd = rendered + 1;
        const before = this.diagnosing && !this.mismatch ? this.snapshotGrains() : null;
        this.renderRange(outL, outR, rendered, chunkEnd);
        if (this.diagnosing && !this.mismatch && before && before.length > 0) {
          const after = this.snapshotGrains();
          const byId = new Map(after.map((g) => [g.id, g]));
          const grains: GrainFrameState[] = before.map((b) => {
            const a = byId.get(b.id);
            return {
              id: b.id,
              instance: b.instance,
              startPos: b.pos,
              startAge: b.age,
              endPos: a ? a.pos : b.pos + (chunkEnd - rendered) * b.rate,
              endAge: a ? a.age : b.age + (chunkEnd - rendered),
              len: b.len,
              rate: b.rate,
              gainL: b.gainL,
              phase: b.phase,
              muted: b.muted,
            };
          });
          // Include grains spawned inside the range (absent from the "before" set).
          const beforeIds = new Set(before.map((g) => g.id));
          for (const a of after) {
            if (!beforeIds.has(a.id)) {
              grains.push({
                id: a.id,
                instance: a.instance,
                startPos: a.pos,
                startAge: a.age,
                endPos: a.pos,
                endAge: a.age,
                len: a.len,
                rate: a.rate,
                gainL: a.gainL,
                phase: a.phase,
                muted: a.muted,
              });
            }
          }
          snapshots.push({ from: rendered, to: chunkEnd, grains });
        }
        rendered = chunkEnd;
      }
      for (const snap of snapshots) {
        if (this.mismatch) break;
        this.scanReferenceQuantum(snap.to - snap.from, snap, snap.from);
      }
      this.applyFadeAndMaster(outL, outR, frames);

      if (this.paused) {
        if (this.fade === 0) {
          this.active = 0;
          this.nextSpawnFrame = this.frame;
        }
        this.playing = true;
      } else if (this.fadeTarget === 0 && this.fade === 0) {
        this.playing = false;
        this.active = 0;
        this.paused = false;
        this.recordActive = false;
      }
      if (!this.paused && this.fadeTarget > 0) this.playFrame += frames;
    }

    this.applyLimiter(outL, outR, frames);
    this.trackAnalysis(outL, outR, frames);
    this.frame += frames;
  }

  /** Records a missed render callback so the UI can surface it as an anomaly. */
  noteCallbackError(): void {
    this.callbackErrors++;
  }

  buildStats(): GrainStats {
    const sr = this.sampleRate;
    const playSeconds = this.playFrame / sr;
    const measureSeconds = clamp(playSeconds, 0.2, 2);
    const from = this.playFrame - measureSeconds * sr;
    let recentSpawns = 0;
    for (let i = 0; i < this.spawnTimeCount && i < this.spawnTimes.length; i++) {
      if (this.spawnTimes[i] >= from) recentSpawns++;
    }
    const measuredDensity = recentSpawns / measureSeconds;

    const analysisWindows = this.silentRingCount;
    const silentWindows = this.silentRingSum;
    const continuity = analysisWindows > 0 ? 1 - silentWindows / analysisWindows : 0;

    const scope: number[] = new Array(SCOPE_LENGTH);
    for (let i = 0; i < SCOPE_LENGTH; i++) {
      scope[i] = this.scopeL[(this.scopeIndex + i) % SCOPE_LENGTH];
    }

    const grains: GrainView[] = [];
    const show = Math.min(this.active, this.capacity);
    for (let i = 0; i < show; i++) {
      const len = this.gLen[i];
      grains.push({
        p: this.source ? clamp(this.gStart[i] / Math.max(1, this.source.length - 1), 0, 1) : 0,
        pan: this.gPan[i],
        age: len > 0 ? clamp(this.gAge[i] / len, 0, 1) : 1,
        duration: this.gDur[i],
        rate: this.gRate[i],
        id: this.gId[i],
      });
    }

    return {
      playing: this.playing,
      paused: this.paused,
      sampleLoaded: !!this.source,
      sourceName: this.sourceName,
      sourceLength: this.source ? this.source.length : 0,
      sampleRate: sr,
      renderedFrames: this.frame,
      sessionSeconds: this.playFrame / sr,
      requestedDensity: this.params.density,
      spawnCount: this.spawnCount,
      epochSpawnCount: this.epochSpawnCount,
      measuredDensity,
      currentActive: this.active,
      peakActive: this.peakActive,
      capacity: this.capacity,
      dropped: this.dropped,
      boundaryTruncated: this.boundaryTruncated,
      boundarySkipped: this.boundarySkipped,
      loopWraps: this.loopWraps,
      outOfRangeReads: this.outOfRangeReads,
      nanSamples: this.nanSamples,
      windowEdgeMax: this.windowEdgeMax,
      readPosMin: Number.isFinite(this.readPosMin) ? this.readPosMin : 0,
      readPosMax: Number.isFinite(this.readPosMax) ? this.readPosMax : 0,
      peak: this.peak,
      densityPeak: this.densityPeak,
      densityActivePeak: this.densityActivePeak,
      rms: this.rmsFrames > 0 ? Math.sqrt(this.rmsAccum / this.rmsFrames) : 0,
      limiterMaxReductionDb: this.limiterMaxReductionDb,
      limiterEngagedFrames: this.limiterEngagedFrames,
      normGain: this.normGain,
      expectedOverlap: this.params.density * this.params.grainDuration,
      continuity,
      longestSilentMs: this.longestSilentMs,
      analysisWindows,
      silentWindows,
      intervalHistogram: [...this.intervalHistogram],
      intervalLabels: [...INTERVAL_LABELS],
      durationHistogram: [...this.durationHistogram],
      durationLabels: [...DURATION_LABELS],
      panHistogram: [...this.panHistogram],
      positionHistogram: [...this.positionHistogram],
      recentRms: [...this.rmsHistory],
      activeHistory: [...this.activeHistory],
      grains,
      scope,
      recordFrames: this.recordWritten,
      recordActive: this.recordActive,
      recordSeconds: this.recordWritten / sr,
      callbackErrors: this.callbackErrors,
      recordDropped: this.recordDropped,
      grainEvents: this.getGrainEvents().slice(-256),
      diagnostic: { ...this.diagnostic },
      mixMismatch: this.mismatch,
      mutedInstances: this.getMutedInstances(),
      phaseOffsets: this.getPhaseOffsets(),
      duplicateSpawns: this.duplicateSpawns,
      endReachedReads: this.endReachedReads,
    };
  }
}
