import { GrainEngine } from '../grain/engine';
import type { GrainParams } from '../grain/types';

interface SourcePayload {
  samples: Float32Array;
  sampleRate: number;
  name: string;
}

type Msg =
  | ({ type: 'load'; } & SourcePayload)
  | { type: 'params'; params: Partial<GrainParams> }
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'record'; on: boolean }
  | { type: 'clear' };

const REPORT_EVERY_N_QUANTA = 2;

class GrainEngineProcessor extends AudioWorkletProcessor {
  private engine: GrainEngine;
  private lastFrame = -1;
  private quantumCounter = 0;
  private scratchL = new Float32Array(0);
  private scratchR = new Float32Array(0);
  private wasRecording = false;

  constructor() {
    super();
    this.engine = new GrainEngine(sampleRate);
    this.port.onmessage = (event: MessageEvent<Msg>) => this.onMessage(event.data);
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  private onMessage(msg: Msg): void {
    switch (msg.type) {
      case 'load':
        this.engine.setSource(msg.samples, msg.sampleRate, msg.name);
        this.port.postMessage({ type: 'loaded', frames: msg.samples.length, sampleRate: msg.sampleRate });
        break;
      case 'params':
        this.engine.setParams(msg.params);
        break;
      case 'play':
        this.engine.play();
        break;
      case 'stop':
        this.engine.stop();
        break;
      case 'pause':
        this.engine.pause();
        break;
      case 'resume':
        this.engine.resume();
        break;
      case 'record':
        if (msg.on) {
          const started = this.engine.startRecording();
          this.port.postMessage({ type: 'record', started });
        } else {
          this.engine.stopRecording();
          this.flushRecording(true);
          this.port.postMessage({ type: 'record', started: false });
        }
        break;
      case 'clear':
        this.engine.clearSource();
        break;
    }
  }

  private flushRecording(final = false): void {
    const chunk = this.engine.drainRecorded();
    if (!chunk) {
      if (final) this.port.postMessage({ type: 'audio', final: true, frames: 0, dropped: false });
      return;
    }
    const left = chunk.left;
    const right = chunk.right;
    this.port.postMessage(
      {
        type: 'audio',
        left: left.buffer,
        right: right.buffer,
        frames: chunk.frames,
        dropped: chunk.dropped,
        final,
      },
      [left.buffer, right.buffer],
    );
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length;
    if (this.scratchL.length !== frames) {
      this.scratchL = new Float32Array(frames);
      this.scratchR = new Float32Array(frames);
    }
    // Detect a genuine timeline discontinuity (not merely quanta of differing size):
    // the gap must exceed one full render quantum.
    if (currentFrame >= 0) {
      if (this.lastFrame >= 0 && Math.abs(currentFrame - this.lastFrame) > Math.max(128, frames)) {
        this.engine.noteCallbackError();
      }
      this.lastFrame = currentFrame + frames;
    } else {
      this.lastFrame = this.lastFrame < 0 ? frames : this.lastFrame + frames;
    }

    this.engine.process(this.scratchL, this.scratchR);
    out[0].set(this.scratchL);
    if (out.length > 1) out[1].set(this.scratchR);
    for (let c = 2; c < out.length; c++) out[c].fill(0);

    this.quantumCounter++;
    if (this.quantumCounter >= REPORT_EVERY_N_QUANTA) {
      this.quantumCounter = 0;
      this.port.postMessage({ type: 'stats', stats: this.engine.buildStats() });
    }
    if (this.engine.isRecording()) {
      this.wasRecording = true;
      this.flushRecording();
    } else if (this.wasRecording) {
      // Recording ended on its own (stop or capacity): ship the remaining tail.
      this.wasRecording = false;
      this.flushRecording(true);
      this.port.postMessage({ type: 'record', started: false });
    }
    return true;
  }
}

registerProcessor('grain-engine', GrainEngineProcessor);
