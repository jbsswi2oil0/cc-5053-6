import { generateMaterial, downmixToMono } from './grain/materials';
import type { MaterialId } from './grain/types';
import { GrainEngine } from './grain/engine';
import { DEFAULT_PARAMS, GrainParams, GrainStats } from './grain/types';
import { createPanel } from './ui/panel';
import { createDiagnosticPanel, renderDiagnosticPanel } from './ui/diagnostics-panel';
import type { DiagnosticFlags } from './grain/types';
import { drawGrainView, drawHistograms, drawPositionStrip, drawRmsHistory, drawScope, drawSource } from './ui/draw';

import workletUrl from './worklet/grain-processor.ts?worker&url';

const WORKLET_URL = workletUrl;
const TEST_MODE = new URLSearchParams(location.search).has('test');

type EngineMessage =
  | { type: 'ready'; sampleRate: number }
  | { type: 'loaded'; frames: number; sampleRate: number }
  | { type: 'record'; started: boolean }
  | { type: 'stats'; stats: GrainStats }
  | {
      type: 'audio';
      left?: ArrayBuffer;
      right?: ArrayBuffer;
      frames: number;
      dropped: boolean;
      final?: boolean;
    };

interface RecordedChunk {
  left: ArrayBuffer;
  right: ArrayBuffer;
}

class GrainConsole {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private params: GrainParams = { ...DEFAULT_PARAMS };
  private source: { samples: Float32Array; name: string; id: MaterialId | 'file' } | null = null;
  private stats: GrainStats | null = null;
  private latest: GrainStats | null = null;
  private recording = false;
  private finalized = false;
  private recordedChunks: RecordedChunk[] = [];
  private panelRefs = createPanelRefs();
  private diagRefs = createDiagnosticPanel({
    postDiagnostic: (patch) => this.postDiagnostic(patch),
    postMuteInstance: (instance, muted) => this.postMuteInstance(instance, muted),
    postPhaseInstance: (instance, offsetFrames) => this.postPhaseInstance(instance, offsetFrames),
    postDiagnosis: (on) => this.postDiagnosis(on),
  });

  private playBtn = document.getElementById('playBtn') as HTMLButtonElement;
  private pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
  private stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
  private recBtn = document.getElementById('recBtn') as HTMLButtonElement;
  private downloadBtn = document.getElementById('downloadBtn') as HTMLAnchorElement;
  private ctxState = document.getElementById('ctxState')!;
  private srcState = document.getElementById('srcState')!;
  private recStatus = document.getElementById('recStatus')!;

  constructor() {
    createPanel(this);
    this.bindButtons();
    this.bindMaterial();
    this.bindFile();
    this.bindBoundary();
    this.startRenderLoop();
    this.selectMaterial('steady', false);
  }

  getParams(): GrainParams {
    return { ...this.params };
  }

  getStats(): GrainStats | null {
    return this.stats;
  }

  setParam(key: keyof GrainParams, value: number | string): void {
    (this.params as unknown as Record<string, unknown>)[key] = value;
    this.pushParams();
  }

  setAllParams(next: Partial<GrainParams>): void {
    this.params = { ...this.params, ...next };
    this.pushParams();
  }

  private pushParams(): void {
    if (this.node) this.node.port.postMessage({ type: 'params', params: { ...this.params } });
  }

  postDiagnostic(patch: Partial<DiagnosticFlags>): void {
    this.node?.port.postMessage({ type: 'diagnostic', patch });
  }

  postMuteInstance(instance: number, muted: boolean): void {
    this.node?.port.postMessage({ type: 'mute-instance', instance, muted });
  }

  postPhaseInstance(instance: number, offsetFrames: number | null): void {
    this.node?.port.postMessage({ type: 'phase-instance', instance, offsetFrames });
  }

  postDiagnosis(on: boolean): void {
    this.node?.port.postMessage({ type: 'diagnosis', on });
  }

  private async ensureEngine(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(ctx, 'grain-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (event: MessageEvent<EngineMessage>) => this.onEngineMessage(event.data);
    node.connect(ctx.destination);
    this.node = node;
    this.setCtxState('running');
    this.pushParams();
    if (this.source) this.postSource();
    return ctx;
  }

  private postSource(): void {
    if (!this.node || !this.source) return;
    this.node.port.postMessage({
      type: 'load',
      samples: this.source.samples,
      sampleRate: this.ctx?.sampleRate ?? 48000,
      name: this.source.name,
    });
  }

  /** Test-only: replace the source with a caller-provided (e.g. very short) buffer. */
  async loadTestSource(samples: Float32Array, name = 'test-short'): Promise<void> {
    const ctx = await this.ensureEngine();
    this.source = { samples, name, id: 'file' };
    this.node?.port.postMessage({ type: 'load', samples, sampleRate: ctx.sampleRate, name });
    this.updateSourceView();
  }

  private setCtxState(state: string): void {
    this.ctxState.className = 'pill live';
    this.ctxState.textContent = `引擎运行 · ${this.ctx?.sampleRate ?? 0} Hz · 量子 ${this.ctx?.baseLatency ? (this.ctx.baseLatency * 1000).toFixed(1) : '—'} ms · ${state}`;
  }

  private onEngineMessage(msg: EngineMessage): void {
    switch (msg.type) {
      case 'ready':
        break;
      case 'loaded':
        this.srcState.className = 'pill live';
        this.srcState.textContent = `样本 ${(msg.frames / msg.sampleRate).toFixed(2)} s · ${msg.sampleRate} Hz`;
        break;
      case 'record':
        break;
      case 'stats':
        this.stats = msg.stats;
        this.latest = msg.stats;
        this.updateControlsFromStats(msg.stats);
        break;
      case 'audio':
        if (msg.left && msg.right) {
          this.recordedChunks.push({ left: msg.left, right: msg.right });
        }
        if (msg.final && !this.finalized) {
          this.finalized = true;
          this.recording = false;
          this.recBtn.classList.remove('recording');
          this.recBtn.textContent = '录制';
          this.finishRecording();
        }
        break;
    }
  }

  private bindButtons(): void {
    this.playBtn.addEventListener('click', () => void this.play());
    this.pauseBtn.addEventListener('click', () => void this.togglePause());
    this.stopBtn.addEventListener('click', () => void this.stop());
    this.recBtn.addEventListener('click', () => this.toggleRecording());
    this.downloadBtn.addEventListener('click', (e) => {
      if (this.downloadBtn.classList.contains('disabled')) e.preventDefault();
    });
  }

  async play(): Promise<void> {
    const ctx = await this.ensureEngine();
    if (!this.source) {
      await this.selectMaterial('steady', false);
    }
    if (!this.node) return;
    this.postSource();
    this.recordedChunks = [];
    this.node.port.postMessage({ type: 'play' });
    this.playBtn.disabled = true;
    this.pauseBtn.disabled = false;
    this.pauseBtn.textContent = '暂停';
    this.stopBtn.disabled = false;
    this.recBtn.disabled = false;
    if (ctx.state === 'suspended') await ctx.resume();
    this.setCtxState('running');
    document.body.dataset.playing = 'true';
  }

  async togglePause(): Promise<void> {
    if (!this.node || !this.stats) return;
    if (this.stats.paused) {
      this.node.port.postMessage({ type: 'resume' });
      this.pauseBtn.textContent = '暂停';
      document.body.dataset.paused = 'false';
    } else {
      this.node.port.postMessage({ type: 'pause' });
      this.pauseBtn.textContent = '继续';
      document.body.dataset.paused = 'true';
    }
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    this.node.port.postMessage({ type: 'stop' });
    this.playBtn.disabled = false;
    this.pauseBtn.disabled = true;
    this.stopBtn.disabled = true;
    if (this.recording) {
      this.node.port.postMessage({ type: 'record', on: false });
      this.recBtn.classList.remove('recording');
      this.recBtn.textContent = '录制';
    }
    this.recBtn.disabled = true;
    document.body.dataset.playing = 'false';
    document.body.dataset.paused = 'false';
  }

  private toggleRecording(): void {
    if (!this.node) return;
    if (!this.recording) {
      this.recording = true;
      this.finalized = false;
      this.recordedChunks = [];
      this.node.port.postMessage({ type: 'record', on: true });
      this.recBtn.classList.add('recording');
      this.recBtn.textContent = '停止录制';
      this.recStatus.textContent = '录音：录制中…';
    } else {
      this.node.port.postMessage({ type: 'record', on: false });
      this.recBtn.classList.remove('recording');
      this.recBtn.textContent = '录制';
      this.recStatus.textContent = '录音：收尾…';
    }
  }

  private finishRecording(): void {
    if (!this.ctx || this.recordedChunks.length === 0) {
      this.recStatus.textContent = '录音：无数据（请先播放）';
      return;
    }
    this.downloadBtn.classList.remove('disabled');
    let total = 0;
    for (const c of this.recordedChunks) total += c.left.byteLength / 4;
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let offset = 0;
    for (const c of this.recordedChunks) {
      const l = new Float32Array(c.left);
      const r = new Float32Array(c.right);
      left.set(l, offset);
      right.set(r, offset);
      offset += l.length;
    }
    const wav = encodeWav(left, right, this.ctx.sampleRate);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    this.downloadBtn.href = url;
    this.downloadBtn.className = 'btn ghost';
    this.downloadBtn.textContent = `下载录音 (${(total / this.ctx.sampleRate).toFixed(1)} s)`;
    this.recStatus.textContent = `录音：完成 ${(total / this.ctx.sampleRate).toFixed(2)} s · ${this.ctx.sampleRate} Hz`;
  }

  private bindMaterial(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-material]').forEach((btn) => {
      btn.addEventListener('click', () => void this.selectMaterial(btn.dataset.material as MaterialId, true));
    });
  }

  async selectMaterial(id: MaterialId, _startIfIdle = false): Promise<void> {
    await this.selectMaterialInternal(id);
  }

  private async selectMaterialInternal(id: MaterialId): Promise<void> {
    const ctx = await this.ensureEngine();
    const samples = generateMaterial(id, ctx.sampleRate);
    this.source = { samples, name: id, id };
    this.postSource();
    document.querySelectorAll<HTMLButtonElement>('[data-material]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.material === id);
    });
    this.updateSourceView();
  }

  private bindFile(): void {
    const input = document.getElementById('fileInput') as HTMLInputElement;
    const drop = document.getElementById('fileDrop')!;
    const load = async (file: File) => {
      const ctx = await this.ensureEngine();
      const buf = await file.arrayBuffer();
      try {
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        const samples = downmixToMono(decoded);
        this.source = { samples, name: file.name, id: 'file' };
        this.postSource();
        document.querySelectorAll<HTMLButtonElement>('[data-material]').forEach((b) => b.classList.remove('active'));
        this.updateSourceView();
      } catch {
        this.srcState.className = 'pill error';
        this.srcState.textContent = '无法解码该音频文件';
      }
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void load(file);
    });
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('drag');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drag');
      const file = e.dataTransfer?.files?.[0];
      if (file) void load(file);
    });
  }

  private bindBoundary(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-boundary]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.boundary as 'clip' | 'loop';
        this.params.boundary = value;
        this.pushParams();
        document.querySelectorAll<HTMLButtonElement>('[data-boundary]').forEach((b) =>
          b.classList.toggle('active', b.dataset.boundary === value),
        );
        const note = document.getElementById('policyNote')!;
        note.textContent =
          value === 'clip'
            ? '截取：颗粒被限制在样本内部，必要时缩短时长；读取永不越过样本末尾。'
            : '循环：颗粒按读取速度在样本内回绕，回绕由引擎计数，仍无越界读取。';
      });
    });
  }

  private updateSourceView(): void {
    if (!this.source || !this.ctx) return;
    drawSource(document.getElementById('sourceCanvas') as HTMLCanvasElement, this.source.samples);
    const seconds = this.source.samples.length / this.ctx.sampleRate;
    document.getElementById('sourceMeta')!.textContent =
      `素材：${this.source.name} · ${seconds.toFixed(2)} s · ${this.source.samples.length} 帧 · ${this.ctx.sampleRate} Hz`;
    this.srcState.className = 'pill live';
    this.srcState.textContent = `已加载 ${seconds.toFixed(2)} s`;
  }

  private updateControlsFromStats(stats: GrainStats): void {
    const playing = stats.playing;
    const paused = stats.paused;
    this.playBtn.disabled = playing && !paused;
    this.pauseBtn.disabled = !playing;
    this.stopBtn.disabled = !playing;
    this.recBtn.disabled = !playing;
    if (playing) {
      this.pauseBtn.textContent = paused ? '继续' : '暂停';
    }
    if (stats.nanSamples > 0 || stats.callbackErrors > 0) {
      this.ctxState.className = 'pill error';
    }
  }

  private startRenderLoop(): void {
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private render(): void {
    const stats = this.latest;
    if (!stats) return;
    const panel = this.panelRefs;
    panel.continuityVal.textContent = stats.analysisWindows > 0 ? `${(stats.continuity * 100).toFixed(1)}%` : '—';
    panel.silentVal.textContent =
      stats.analysisWindows > 0 ? `${stats.longestSilentMs.toFixed(1)} ms` : '—';
    panel.windowVal.textContent = `${stats.analysisWindows}`;
    panel.measuredVal.textContent = `${stats.measuredDensity.toFixed(1)} /s`;
    panel.peakVal.textContent = stats.peak.toFixed(3);
    panel.activeVal.textContent = `${stats.currentActive}`;
    panel.capacityVal.textContent = `${stats.capacity}`;
    panel.activeBar.style.width = `${Math.min(100, (stats.currentActive / stats.capacity) * 100)}%`;
    const rms = stats.recentRms;
    const lastRms = rms.length > 0 ? rms[rms.length - 1] : 0;
    const levelDb = 20 * Math.log10(Math.max(1e-5, lastRms));
    panel.levelBar.style.width = `${Math.max(0, Math.min(100, ((levelDb + 60) / 60) * 100))}%`;
    panel.grainNow.textContent = `${stats.currentActive}`;
    panel.grainPeak.textContent = `${stats.peakActive}`;
    panel.grainSpawned.textContent = `${stats.epochSpawnCount}`;
    panel.grainDropped.textContent = `${stats.dropped}`;
    drawRmsHistory(panel.rmsCanvas, stats.recentRms);
    drawScope(panel.scopeCanvas, stats.scope);
    drawGrainView(panel.grainCanvas, stats.grains, stats.sourceLength, stats.requestedDensity);
    drawHistograms(panel.intervalHist, stats.intervalHistogram, stats.intervalLabels, true);
    drawHistograms(panel.durationHist, stats.durationHistogram, stats.durationLabels, false);
    drawHistograms(panel.panHist, stats.panHistogram, ['L', '', '', '', 'C', '', '', '', 'R'], false);
    drawPositionStrip(panel.positionStrip, stats.positionHistogram);
    panel.intervalTotal.textContent = `${stats.epochSpawnCount}`;
    panel.durationTotal.textContent = `${stats.epochSpawnCount}`;
    panel.panTotal.textContent = `${stats.epochSpawnCount}`;

    this.renderMetrics(stats, panel);
    this.renderAnomalies(stats, panel);
    this.renderFooter(stats);
    renderDiagnosticPanel(this.diagRefs, stats);
  }

  private renderMetrics(stats: GrainStats, panel: ReturnType<typeof createPanelRefs>): void {
    const set = (el: HTMLElement, text: string, cls = '') => {
      el.textContent = text;
      el.className = cls;
    };
    set(panel.metricWindow, stats.windowEdgeMax.toFixed(3), stats.windowEdgeMax > 0.0005 ? 'warn' : '');
    set(panel.metricOob, `${stats.outOfRangeReads}`, stats.outOfRangeReads > 0 ? 'bad' : '');
    set(panel.metricNan, `${stats.nanSamples}`, stats.nanSamples > 0 ? 'bad' : '');
    set(panel.metricBoundary, `${stats.boundaryTruncated} / ${stats.boundarySkipped}`);
    set(panel.metricLoop, `${stats.loopWraps}`, stats.loopWraps > 0 ? 'warn' : '');
    set(panel.metricNorm, stats.normGain.toFixed(3));
    set(panel.metricOverlap, stats.expectedOverlap.toFixed(2));
    set(
      panel.metricLimiter,
      `${stats.limiterMaxReductionDb.toFixed(1)} dB`,
      stats.limiterMaxReductionDb < -3 ? 'warn' : '',
    );
    set(panel.metricCallbacks, `${stats.callbackErrors}`, stats.callbackErrors > 0 ? 'bad' : '');
    set(panel.metricRecDrop, stats.recordDropped ? '是（已达 60 s）' : '否', stats.recordDropped ? 'warn' : '');
    set(
      panel.metricReadRange,
      stats.sampleLoaded ? `${stats.readPosMin.toFixed(0)}–${stats.readPosMax.toFixed(0)}` : '—',
      stats.outOfRangeReads > 0 ? 'bad' : '',
    );
    set(
      panel.metricDensityPeak,
      `${stats.densityPeak.toFixed(3)} / ${stats.densityActivePeak}`,
      stats.densityPeak >= 0.99 ? 'bad' : '',
    );
    this.renderChecks(stats, panel);
  }

  private renderChecks(stats: GrainStats, panel: ReturnType<typeof createPanelRefs>): void {
    const started = stats.epochSpawnCount > 0;
    const windowPass = stats.windowEdgeMax < 1e-5 && stats.outOfRangeReads === 0 && stats.nanSamples === 0;
    const countPass = stats.currentActive <= stats.capacity && stats.peakActive <= stats.capacity;
    const peakPass = stats.densityPeak < 0.99;
    const apply = (
      el: HTMLElement,
      pass: boolean,
      value: string,
    ) => {
      if (!started) {
        el.className = 'check';
        (el.querySelector('.chk-val') as HTMLElement).textContent = '待测';
        return;
      }
      el.className = `check ${pass ? 'pass' : 'fail'}`;
      (el.querySelector('.chk-val') as HTMLElement).textContent = `${pass ? '通过' : '不合格'} · ${value}`;
    };
    apply(panel.checkWindow, windowPass, `边界 ${stats.windowEdgeMax.toExponential(1)} · 越界 ${stats.outOfRangeReads}`);
    apply(panel.checkCount, countPass, `当前 ${stats.currentActive} · 峰值 ${stats.peakActive} / ${stats.capacity}`);
    apply(panel.checkPeak, peakPass, `${stats.densityPeak.toFixed(3)} @ ${stats.requestedDensity}/s`);
  }

  private renderAnomalies(stats: GrainStats, panel: ReturnType<typeof createPanelRefs>): void {
    const items: { level: 'ok' | 'warn' | 'bad'; text: string }[] = [];
    if (stats.spawnCount === 0) {
      items.push({ level: 'ok', text: '尚未播放。启动后此处显示由实际运算得到的异常与提示。' });
    } else {
      if (stats.outOfRangeReads > 0) {
        items.push({
          level: 'bad',
          text: `检测到 ${stats.outOfRangeReads} 次越界读取，已钳制到样本边缘。请检查边界政策。`,
        });
      }
      if (stats.nanSamples > 0) {
        items.push({ level: 'bad', text: `检测到 ${stats.nanSamples} 个非有限样本，已在引擎内拦截。` });
      }
      if (stats.dropped > 0) {
        items.push({
          level: 'warn',
          text: `声部池已满，丢弃 ${stats.dropped} 颗颗粒（上限 ${stats.capacity}）。降低密度或时长以避免。`,
        });
      }
      if (stats.windowEdgeMax > 0.0005) {
        items.push({
          level: 'bad',
          text: `窗边界未归零（最大 ${stats.windowEdgeMax.toFixed(4)}），颗粒边缘可能产生爆音。`,
        });
      }
      if (stats.callbackErrors > 0) {
        items.push({
          level: 'warn',
          text: `音频回调出现 ${stats.callbackErrors} 次时间戳不连续，可能发生欠载。`,
        });
      }
      if (stats.limiterMaxReductionDb < -6) {
        items.push({
          level: 'warn',
          text: `限幅器最大衰减 ${Math.abs(stats.limiterMaxReductionDb).toFixed(1)} dB，密度与增益偏高。`,
        });
      }
      if (stats.analysisWindows > 0 && stats.continuity < 0.9) {
        items.push({
          level: 'warn',
          text: `连续占比 ${(stats.continuity * 100).toFixed(0)}%，低于 90%。可提高密度或颗粒时长。`,
        });
      }
      const densityError = Math.abs(stats.measuredDensity - stats.requestedDensity);
      const densityTol = Math.max(2.5, stats.requestedDensity * 0.28);
      if (stats.requestedDensity >= 4 && densityError > densityTol) {
        items.push({
          level: 'warn',
          text: `测量密度 ${stats.measuredDensity.toFixed(1)}/s 偏离设定 ${stats.requestedDensity}/s，密度调度可能受限。`,
        });
      }
      if (stats.paused) {
        items.push({ level: 'ok', text: '已暂停：引擎继续计时，恢复后颗粒时间线按样本帧继续。' });
      }
      if (stats.recordActive) {
        items.push({ level: 'ok', text: '正在录制实际输出（由音频回调供数，不依赖界面刷新）。' });
      }
      if (stats.recordDropped) {
        items.push({ level: 'warn', text: '录音已达 60 秒上限，后续输出未写入；请在达到上限前停止录制。' });
      }
      if (items.length === 0) {
        items.push({ level: 'ok', text: '全部检查通过：窗边界归零、无越界读取、颗粒数量在池容量内。' });
      }
    }
    const worst = items.some((i) => i.level === 'bad')
      ? 'bad'
      : items.some((i) => i.level === 'warn')
        ? 'warn'
        : 'ok';
    panel.anomalyCount.className = `badge ${worst}`;
    panel.anomalyCount.textContent = worst === 'bad' ? '需注意' : worst === 'warn' ? '提示' : '正常';
    panel.anomalies.innerHTML = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = item.level;
      li.textContent = item.text;
      panel.anomalies.appendChild(li);
    }
    panel.contHint.textContent =
      stats.analysisWindows > 0
        ? `${stats.analysisWindows} 个 10 ms 窗 · ${stats.silentWindows} 个静音`
        : '实际渲染输出测量';
  }

  private renderFooter(stats: GrainStats): void {
    if (this.recording) {
      this.recStatus.textContent = `录音：录制中 · ${(stats.recordFrames / stats.sampleRate).toFixed(1)} s`;
    } else if (this.downloadBtn.classList.contains('disabled')) {
      this.recStatus.textContent = '录音：待机';
    }
  }
}

function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): ArrayBuffer {
  const frames = left.length;
  const bytesPerSample = 2;
  const blockAlign = 2 * bytesPerSample;
  const buffer = new ArrayBuffer(44 + frames * blockAlign);
  const view = new DataView(buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + frames * blockAlign, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, frames * blockAlign, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, Math.max(-1, Math.min(1, left[i])) * 0x7fff, true);
    view.setInt16(offset + 2, Math.max(-1, Math.min(1, right[i])) * 0x7fff, true);
    offset += 4;
  }
  return buffer;
}

function createPanelRefs() {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    continuityVal: get<HTMLElement>('continuityVal'),
    silentVal: get<HTMLElement>('silentVal'),
    windowVal: get<HTMLElement>('windowVal'),
    measuredVal: get<HTMLElement>('measuredVal'),
    peakVal: get<HTMLElement>('peakVal'),
    activeVal: get<HTMLElement>('activeVal'),
    capacityVal: get<HTMLElement>('capacityVal'),
    activeBar: get<HTMLElement>('activeBar'),
    levelBar: get<HTMLElement>('levelBar'),
    grainNow: get<HTMLElement>('grainNow'),
    grainPeak: get<HTMLElement>('grainPeak'),
    grainSpawned: get<HTMLElement>('grainSpawned'),
    grainDropped: get<HTMLElement>('grainDropped'),
    rmsCanvas: get<HTMLCanvasElement>('rmsCanvas'),
    scopeCanvas: get<HTMLCanvasElement>('scopeCanvas'),
    grainCanvas: get<HTMLCanvasElement>('grainCanvas'),
    intervalHist: get<HTMLElement>('intervalHist'),
    durationHist: get<HTMLElement>('durationHist'),
    panHist: get<HTMLElement>('panHist'),
    positionStrip: get<HTMLElement>('positionStrip'),
    intervalTotal: get<HTMLElement>('intervalTotal'),
    durationTotal: get<HTMLElement>('durationTotal'),
    panTotal: get<HTMLElement>('panTotal'),
    metricWindow: get<HTMLElement>('metricWindow'),
    metricOob: get<HTMLElement>('metricOob'),
    metricNan: get<HTMLElement>('metricNan'),
    metricBoundary: get<HTMLElement>('metricBoundary'),
    metricLoop: get<HTMLElement>('metricLoop'),
    metricNorm: get<HTMLElement>('metricNorm'),
    metricOverlap: get<HTMLElement>('metricOverlap'),
    metricLimiter: get<HTMLElement>('metricLimiter'),
    metricCallbacks: get<HTMLElement>('metricCallbacks'),
    metricRecDrop: get<HTMLElement>('metricRecDrop'),
    metricReadRange: get<HTMLElement>('metricReadRange'),
    metricDensityPeak: get<HTMLElement>('metricDensityPeak'),
    checkWindow: get<HTMLElement>('checkWindow'),
    checkCount: get<HTMLElement>('checkCount'),
    checkPeak: get<HTMLElement>('checkPeak'),
    anomalyCount: get<HTMLElement>('anomalyCount'),
    anomalies: get<HTMLUListElement>('anomalies'),
    contHint: get<HTMLElement>('contHint'),
    sourceCanvas: get<HTMLCanvasElement>('sourceCanvas'),
    sourceMeta: get<HTMLElement>('sourceMeta'),
  };
}

const consoleApp = new GrainConsole();
if (TEST_MODE) {
  (window as unknown as { __grain: { app: GrainConsole; Engine: typeof GrainEngine } }).__grain = {
    app: consoleApp,
    Engine: GrainEngine,
  };
}