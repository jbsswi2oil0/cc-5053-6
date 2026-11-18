import type { GrainParams } from '../grain/types';

export interface ConsoleLike {
  setParam(key: keyof GrainParams, value: number | string): void;
  getParams(): GrainParams;
  setAllParams(next: Partial<GrainParams>): void;
  play(): Promise<void>;
}

interface SliderSpec {
  id: string;
  labelId: string;
  key: keyof GrainParams;
  scale: number;
  format: (value: number) => string;
}

const SLIDERS: SliderSpec[] = [
  { id: 'density', labelId: 'densityVal', key: 'density', scale: 1, format: (v) => `${v.toFixed(0)} /s` },
  { id: 'duration', labelId: 'durationVal', key: 'grainDuration', scale: 0.001, format: (v) => `${(v * 1000).toFixed(0)} ms` },
  { id: 'durJitter', labelId: 'durJitterVal', key: 'durationJitter', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
  { id: 'speed', labelId: 'speedVal', key: 'readSpeed', scale: 1, format: (v) => `${v.toFixed(2)}×` },
  { id: 'speedJitter', labelId: 'speedJitterVal', key: 'speedJitter', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
  { id: 'position', labelId: 'positionVal', key: 'position', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
  { id: 'posJitter', labelId: 'posJitterVal', key: 'positionJitter', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
  { id: 'spread', labelId: 'spreadVal', key: 'spread', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
  { id: 'amp', labelId: 'ampVal', key: 'amplitude', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
  { id: 'master', labelId: 'masterVal', key: 'masterGain', scale: 0.01, format: (v) => `${(v * 100).toFixed(0)} %` },
];

export function createPanel(app: ConsoleLike): void {
  const params = app.getParams();
  for (const spec of SLIDERS) {
    const input = document.getElementById(spec.id) as HTMLInputElement;
    const label = document.getElementById(spec.labelId) as HTMLElement;
    const initial = Math.round((params[spec.key] as number) / spec.scale);
    input.value = `${initial}`;
    label.textContent = spec.format(params[spec.key] as number);
    const handler = () => {
      const value = Number(input.value) * spec.scale;
      app.setParam(spec.key, value);
      label.textContent = spec.format(value);
    };
    input.addEventListener('input', handler);
  }

  const seedInput = document.getElementById('seed') as HTMLInputElement;
  const seedBtn = document.getElementById('seedBtn') as HTMLButtonElement;
  const applySeed = () => {
    const n = Number(seedInput.value);
    if (Number.isFinite(n)) app.setParam('seed', Math.abs(Math.floor(n)) >>> 0);
  };
  seedInput.addEventListener('change', applySeed);
  seedBtn.addEventListener('click', () => {
    const next = (Math.random() * 0xffffffff) >>> 0;
    seedInput.value = `${next}`;
    app.setParam('seed', next);
  });

  document.body.dataset.panelReady = 'true';
}
