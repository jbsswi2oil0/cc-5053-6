/**
 * Shared Hann (sin²) window table. Both the live renderer and the independent
 * diagnostic reference must evaluate windows through this exact table so their
 * frame-for-frame comparison measures mixing correctness rather than the tiny
 * difference between a sin() call and its tabulated approximation.
 */
export const WINDOW_SIZE = 4097;

export const WINDOW_TABLE = new Float64Array(WINDOW_SIZE);
for (let i = 0; i < WINDOW_SIZE; i++) {
  const x = i / (WINDOW_SIZE - 1);
  const s = Math.sin(Math.PI * x);
  WINDOW_TABLE[i] = s * s;
}

export function windowAt(age: number, len: number): number {
  if (len <= 1) return 0;
  const widx = (age / (len - 1)) * (WINDOW_SIZE - 1);
  const wi0 = widx | 0;
  const w0 = WINDOW_TABLE[wi0];
  const w1 = wi0 < WINDOW_SIZE - 1 ? WINDOW_TABLE[wi0 + 1] : 0;
  return w0 + (w1 - w0) * (widx - wi0);
}

/** Play/pause ramp length in seconds; must match GrainEngine.applyFadeRates. */
export const FADE_SECONDS = 0.012;

/**
 * The engine's fade-in envelope at a given rendered frame, reproduced exactly
 * (per-frame additive ramp clamped at 1) so an independent reference can be
 * compared against the post-fade live output across the whole buffer.
 */
export function fadeEnvelopeAt(frame: number, sampleRate: number): number {
  const step = 1 / (FADE_SECONDS * sampleRate);
  return Math.min(1, (frame + 1) * step);
}
