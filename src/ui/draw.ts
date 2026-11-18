import type { GrainView } from '../grain/types';

function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(80, Math.round(rect.width * dpr));
  const h = Math.max(40, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { ctx, w, h };
}

export function drawSource(canvas: HTMLCanvasElement, samples: Float32Array): void {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a1118';
  ctx.fillRect(0, 0, w, h);
  const mid = h / 2;
  ctx.strokeStyle = '#1c2b3a';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
  ctx.fillStyle = 'rgba(75, 179, 227, 0.75)';
  const step = Math.max(1, Math.floor(samples.length / w));
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const from = x * step;
    const to = Math.min(samples.length, from + step);
    for (let i = from; i < to; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) continue;
    const y0 = mid - max * mid * 0.9;
    const y1 = mid - min * mid * 0.9;
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

export function drawRmsHistory(canvas: HTMLCanvasElement, values: number[]): void {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a1118';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#15212d';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  if (values.length < 2) return;
  const max = Math.max(0.05, ...values);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(75, 227, 168, 0.85)');
  grad.addColorStop(1, 'rgba(75, 227, 168, 0.05)');
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < values.length; i++) {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = h - Math.min(1, values[i] / max) * (h - 6) - 3;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = h - Math.min(1, values[i] / max) * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#4be3a8';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

export function drawScope(canvas: HTMLCanvasElement, scope: number[]): void {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a1118';
  ctx.fillRect(0, 0, w, h);
  const mid = h / 2;
  ctx.strokeStyle = '#15212d';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
  if (scope.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < scope.length; i++) {
    const x = (i / (scope.length - 1)) * w;
    const y = mid - scope[i] * (mid - 3);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(75, 179, 227, 0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function drawGrainView(
  canvas: HTMLCanvasElement,
  grains: GrainView[],
  sourceLength: number,
  density: number,
): void {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a1118';
  ctx.fillRect(0, 0, w, h);
  const pad = 8;
  const left = pad;
  const top = pad;
  const width = w - pad * 2;
  const height = h - pad * 2;
  ctx.strokeStyle = '#15212d';
  ctx.strokeRect(left, top, width, height);
  ctx.fillStyle = '#5c7086';
  ctx.font = `${Math.max(8, Math.round(9 * Math.min(2, window.devicePixelRatio || 1)))}px monospace`;
  ctx.fillText(`source ${sourceLength} frames`, left + 2, top + height - 4);
  ctx.fillText(`${density.toFixed(0)}/s · ${grains.length} active`, left + 2, top + 11);
  for (const g of grains) {
    const x = left + g.p * width;
    const y = top + ((g.pan + 1) / 2) * height;
    const radius = 1.5 + Math.min(5, g.duration * 60);
    const alpha = 0.25 + 0.7 * (1 - g.age);
    const hue = 150 + g.rate * 20;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 70%, 58%, ${alpha.toFixed(3)})`;
    ctx.fill();
    if (g.age < 0.2) {
      ctx.strokeStyle = `rgba(75, 227, 168, ${(0.5 * (1 - g.age / 0.2)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

export function drawHistograms(
  container: HTMLElement,
  values: number[],
  labels: string[],
  showValue: boolean,
): void {
  const max = Math.max(1, ...values);
  const existing = container.querySelectorAll<HTMLElement>('.bar');
  for (let i = 0; i < values.length; i++) {
    let bar = existing[i];
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = '<span></span>';
      container.appendChild(bar);
    }
    const ratio = values[i] / max;
    bar.style.height = `${Math.max(2, ratio * 100)}%`;
    bar.title = `${labels[i] ?? ''}: ${values[i]}`;
    if (showValue) {
      const span = bar.querySelector('span')!;
      span.textContent = values[i] > 0 ? `${values[i]}` : '';
    }
  }
}

export function drawPositionStrip(container: HTMLElement, values: number[]): void {
  const max = Math.max(1, ...values);
  const cells = container.querySelectorAll<HTMLElement>('.cell');
  for (let i = 0; i < values.length; i++) {
    let cell = cells[i];
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'cell';
      cell.innerHTML = '<i></i>';
      container.appendChild(cell);
    }
    const inner = cell.querySelector('i') as HTMLElement;
    const ratio = values[i] / max;
    inner.style.height = `${Math.max(2, ratio * 100)}%`;
    cell.title = `${Math.round((i / values.length) * 100)}–${Math.round(((i + 1) / values.length) * 100)}%: ${values[i]}`;
  }
}
