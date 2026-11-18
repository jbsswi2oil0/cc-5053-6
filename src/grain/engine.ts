import {
  DEFAULT_PARAMS,
  DURATION_EDGES,
  DURATION_LABELS,
  GrainParams,
  GrainStats,
  GrainView,
  INTERVAL_EDGES,
  INTERVAL_LABELS,
  PAN_BINS,
  POSITION_BINS,
} from './types';

const WINDOW_SIZE = 4097;
const WT = new Float64Array(WINDOW_SIZE);
for (let i = 0; i < WINDOW_SIZE; i++) {
  const x = i / (WINDOW_SIZE - 1);
  const s = Math.sin(Math.PI * x);
  WT[i] = s * s;
}

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
  private nextGrainId = 1;

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
    this.fadeStep = 1 / (0.012 * this.sampleRate);
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

  play(): void {
    if (!this.source) return;
    this.resetSession();
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
  }

  /** Power normalisation: energy stays bounded as overlapping grain count grows. */
  private computeNorm(): void {
    const overlap = this.params.density * this.params.grainDuration;
    this.normGain = 1 / Math.sqrt(Math.max(0.75, overlap));
  }

  private spawnGrain(): boolean {
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

    const required = (len - 1) * rate;
    if (required > span) {
      if (p.boundary === 'clip') {
        len = Math.floor(span / rate) + 1;
        if (len < 4) {
          this.boundarySkipped++;
          return false;
        }
        this.boundaryTruncated++;
      }
    }

    const maxStart =
      p.boundary === 'clip' ? Math.max(0, span - (len - 1) * rate) : Math.max(0, span);
    const center = p.position * maxStart;
    const jitter = p.positionJitter * maxStart;
    let start = clamp(center + (this.rand() * 2 - 1) * jitter, 0, maxStart);
    start = Math.round(start);
    if (p.boundary === 'clip' && start + (len - 1) * rate > span + 1e-6) {
      start = Math.floor(maxStart);
    }

    if (this.active >= this.capacity) {
      this.dropped++;
      return false;
    }

    const pan = p.spread * (this.rand() * 2 - 1);
    const angle = ((pan + 1) * Math.PI) / 4;
    const gain = p.amplitude * this.normGain;
    const slot = this.active;
    this.gPos[slot] = start;
    this.gStart[slot] = start;
    this.gLen[slot] = len;
    this.gAge[slot] = 0;
    this.gRate[slot] = rate;
    this.gGainL[slot] = gain * Math.cos(angle) * Math.SQRT2;
    this.gGainR[slot] = gain * Math.sin(angle) * Math.SQRT2;
    this.gId[slot] = this.nextGrainId++;
    this.gPan[slot] = pan;
    this.gDur[slot] = len / sr;
    this.active++;
    if (this.active > this.peakActive) this.peakActive = this.active;
    if (this.active > this.densityActivePeak) this.densityActivePeak = this.active;

    this.spawnCount++;
    this.epochSpawnCount++;
    if (this.lastSpawnPlayFrame >= 0) {
      const intervalMs = ((this.playFrame - this.lastSpawnPlayFrame) / this.sampleRate) * 1000;
      this.intervalHistogram[this.binIndex(INTERVAL_EDGES, intervalMs)]++;
    }
    this.lastSpawnPlayFrame = this.playFrame;
    this.spawnTimes[this.spawnTimeIndex] = this.playFrame;
    this.spawnTimeIndex = (this.spawnTimeIndex + 1) % this.spawnTimes.length;
    this.spawnTimeCount++;

    this.durationHistogram[
      this.binIndex(DURATION_EDGES, this.gDur[slot] * 1000)
    ]++;
    this.panHistogram[Math.min(PAN_BINS - 1, Math.floor(((pan + 1) / 2) * PAN_BINS))]++;
    this.positionHistogram[
      Math.min(POSITION_BINS - 1, Math.floor((start / Math.max(1, span)) * POSITION_BINS))
    ]++;
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
    const maxInterval = sr / ENGINE_LIMITS.maxSpawnPerSecond;
    this.nextSpawnFrame += Math.max(minInterval, maxInterval, jittered);
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
    }
    this.active--;
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
    const wtMax = WINDOW_SIZE - 1;

    for (let n = from; n < to; n++) {
      let sumL = 0;
      let sumR = 0;
      let g = 0;
      while (g < this.active) {
        const len = this.gLen[g];
        const age = this.gAge[g];
        let w: number;
        if (len <= 1) {
          w = 0;
        } else {
          const widx = (age / (len - 1)) * wtMax;
          const wi0 = widx | 0;
          const w0 = WT[wi0];
          const w1 = wi0 < wtMax ? WT[wi0 + 1] : 0;
          w = w0 + (w1 - w0) * (widx - wi0);
        }
        if (age === 0 || age === len - 1) {
          if (w > this.windowEdgeMax) this.windowEdgeMax = w;
        }

        let pos = this.gPos[g];
        if (pos < 0) pos = 0;
        if (pos > srcLen - 1) {
          if (loop) {
            pos -= Math.floor(pos / srcLen) * srcLen;
            this.loopWraps++;
          } else {
            this.outOfRangeReads++;
            pos = srcLen - 1;
          }
        }
        this.gPos[g] = pos;
        if (pos < this.readPosMin) this.readPosMin = pos;
        if (pos > this.readPosMax) this.readPosMax = pos;

        const i0 = pos | 0;
        const frac = pos - i0;
        let i1 = i0 + 1;
        if (i1 >= srcLen) i1 = loop ? 0 : srcLen - 1;
        const s = src[i0] + (src[i1] - src[i0]) * frac;
        if (!Number.isFinite(s)) {
          this.nanSamples++;
        } else {
          sumL += s * this.gGainL[g] * w;
          sumR += s * this.gGainR[g] * w;
        }

        this.gPos[g] = pos + this.gRate[g];
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

      // Interleave spawning and rendering so each grain starts on its exact sample,
      // regardless of how many samples the host delivers per callback.
      let rendered = 0;
      while (rendered < frames) {
        if (spawnAllowed && this.source && this.frame + rendered >= this.nextSpawnFrame) {
          this.spawnGrain();
          this.scheduleNextSpawn();
          continue;
        }
        let chunkEnd = frames;
        if (spawnAllowed && this.source) {
          const nextOffset = Math.ceil(this.nextSpawnFrame - this.frame);
          if (nextOffset > rendered) chunkEnd = Math.min(frames, nextOffset);
        }
        if (chunkEnd <= rendered) chunkEnd = rendered + 1;
        this.renderRange(outL, outR, rendered, chunkEnd);
        rendered = chunkEnd;
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
    };
  }
}
