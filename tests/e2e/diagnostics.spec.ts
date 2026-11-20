import { expect, test } from '@playwright/test';
import type { DiagnosticFlags, GrainStats, MixMismatch } from '../../src/grain/types';

interface FullStats extends GrainStats {
  diagnostic: DiagnosticFlags;
  mixMismatch: MixMismatch | null;
  mutedInstances: number[];
  phaseOffsets: { instance: number; offsetFrames: number }[];
  duplicateSpawns: number;
  endReachedReads: number;
  grainEvents: GrainStats['grainEvents'];
}

declare global {
  interface Window {
    __grain: {
      app: {
        getStats(): FullStats | null;
        setParam(key: string, value: number | string): void;
        play(): Promise<void>;
        stop(): Promise<void>;
        postDiagnostic(patch: Partial<DiagnosticFlags>): void;
        postMuteInstance(instance: number, muted: boolean): void;
        postPhaseInstance(instance: number, offsetFrames: number | null): void;
        postDiagnosis(on: boolean): void;
        loadTestSource(samples: Float32Array, name?: string): Promise<void>;
      };
    };
  }
}

async function stats(page: import('@playwright/test').Page): Promise<FullStats> {
  const s = await page.evaluate(() => window.__grain?.app.getStats() ?? null);
  if (!s) throw new Error('no stats');
  return s;
}

async function waitForSpawns(page: import('@playwright/test').Page, count: number): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__grain?.app.getStats()?.spawnCount ?? 0) > n,
    count,
    { polling: 100 },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?test');
  await expect(page.locator('body')).toHaveAttribute('data-panel-ready', 'true');
});

test('frozen seed replays the identical grain ledger across performances', async ({ page }) => {
  await page.evaluate(() => window.__grain.app.postDiagnostic({ seedFrozen: true }));
  await page.getByRole('button', { name: '播放' }).click();
  await waitForSpawns(page, 20);
  const first = (await stats(page)).grainEvents.map((e) => [e.sourceStart, e.length, e.rate]);
  await page.getByRole('button', { name: '停止' }).click();

  await page.getByRole('button', { name: '播放' }).click();
  await waitForSpawns(page, 20);
  const second = (await stats(page)).grainEvents.map((e) => [e.sourceStart, e.length, e.rate]);
  expect(second.slice(0, first.length)).toEqual(first);
  expect((await stats(page)).diagnostic.seedFrozen).toBe(true);
});

test('withdraws one instance via mute and restores it', async ({ page }) => {
  await page.evaluate(() => window.__grain.app.postDiagnostic({ seedFrozen: true }));
  await page.getByRole('button', { name: '播放' }).click();
  await waitForSpawns(page, 8);
  const target = (await stats(page)).grainEvents[0].instance;

  await page.evaluate((n) => window.__grain.app.postMuteInstance(n, true), target);
  await page.waitForFunction(
    (n) => window.__grain.app.getStats()?.mutedInstances.includes(n) ?? false,
    target,
  );
  const muted = await stats(page);
  expect(muted.mutedInstances).toContain(target);
  expect(muted.grainEvents.find((e) => e.instance === target)?.muted).toBe(true);
  await expect(page.locator('#mutedList')).toContainText(`${target}`);

  await page.evaluate((n) => window.__grain.app.postMuteInstance(n, false), target);
  await page.waitForFunction(
    (n) => !(window.__grain.app.getStats()?.mutedInstances.includes(n) ?? true),
    target,
  );
  expect((await stats(page)).mutedInstances).not.toContain(target);
});

test('applies and clears a per-instance phase offset', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await waitForSpawns(page, 8);
  const target = (await stats(page)).grainEvents[0].instance;

  await page.evaluate((n) => window.__grain.app.postPhaseInstance(n, 120), target);
  await page.waitForFunction(
    (n) => window.__grain.app.getStats()?.phaseOffsets.some((p) => p.instance === n && p.offsetFrames === 120) ?? false,
    target,
  );
  const shifted = await stats(page);
  expect(shifted.phaseOffsets).toContainEqual({ instance: target, offsetFrames: 120 });
  expect(shifted.grainEvents.find((e) => e.instance === target)?.phaseOffset).toBe(120);

  await page.evaluate((n) => window.__grain.app.postPhaseInstance(n, null), target);
  await page.waitForFunction(
    (n) => !(window.__grain.app.getStats()?.phaseOffsets.some((p) => p.instance === n) ?? true),
    target,
  );
});

test('double trigger shares an instance number and is counted', async ({ page }) => {
  await page.evaluate(() =>
    window.__grain.app.postDiagnostic({ injectDoubleTrigger: true }),
  );
  await page.getByRole('button', { name: '播放' }).click();
  await waitForSpawns(page, 10);
  const s = await stats(page);
  expect(s.duplicateSpawns).toBeGreaterThan(0);
  const dupes = s.grainEvents.filter((e) => e.duplicate);
  expect(dupes.length).toBeGreaterThan(0);
  // Each duplicate shares its instance number with a non-duplicate original.
  for (const dupe of dupes) {
    const original = s.grainEvents.find((e) => !e.duplicate && e.instance === dupe.instance);
    expect(original).toBeTruthy();
    expect(original!.spawnFrame).toBe(dupe.spawnFrame);
  }
});

test('window-mix fault is attributed to the window stage and cleared by its switch', async ({ page }) => {
  await page.evaluate(() =>
    window.__grain.app.postDiagnostic({ fixWindowMix: false, injectWindowNormError: true }),
  );
  await page.evaluate(() => window.__grain.app.postDiagnosis(true));
  await page.evaluate(() => window.__grain.app.setParam('density', 120));
  await page.getByRole('button', { name: '播放' }).click();

  await page.waitForFunction(
    () => window.__grain.app.getStats()?.mixMismatch?.attributedStage === 'window-mix',
    undefined,
    { timeout: 15000 },
  );
  const faulty = await stats(page);
  expect(faulty.mixMismatch).not.toBeNull();
  expect(faulty.mixMismatch!.activeInstances.length).toBeGreaterThan(0);
  await expect(page.locator('#mismatchStage')).toContainText('window-mix');
  await expect(page.locator('#mismatchFrame')).not.toHaveText('—');

  // Re-enable only the window-mix fix: the anomaly clears even with the injector still on.
  await page.evaluate(() => window.__grain.app.postDiagnostic({ fixWindowMix: true }));
  await page.waitForFunction(
    () => window.__grain.app.getStats()?.mixMismatch === null,
    undefined,
    { timeout: 15000 },
  );
  expect((await stats(page)).mixMismatch).toBeNull();
  await expect(page.locator('#mismatchState')).toContainText('一致');
});

test('source overrun is attributed to the source stage and ignores the window-only switch', async ({ page }) => {
  // A very short source (128 frames, non-zero throughout) so grain reads cross the end.
  await page.evaluate(() => {
    const src = new Float32Array(128);
    for (let i = 0; i < src.length; i++) src[i] = i < src.length / 2 ? 1 : 0.2;
    return window.__grain.app.loadTestSource(src, 'short-128');
  });
  await page.evaluate(() => window.__grain.app.setParam('grainDuration', 0.05));
  await page.evaluate(() => window.__grain.app.setParam('readSpeed', 1));
  await page.evaluate(() => window.__grain.app.setParam('speedJitter', 0));
  await page.evaluate(() => window.__grain.app.setParam('position', 0.95));
  await page.evaluate(() => window.__grain.app.setParam('positionJitter', 0));
  await page.evaluate(() =>
    window.__grain.app.postDiagnostic({ injectSourceOverrun: true, fixSourceOverrun: false, fixWindowMix: true }),
  );
  await page.evaluate(() => window.__grain.app.postDiagnosis(true));
  await page.getByRole('button', { name: '播放' }).click();

  await page.waitForFunction(
    () => window.__grain.app.getStats()?.mixMismatch?.attributedStage === 'source-overrun',
    undefined,
    { timeout: 15000 },
  );
  // Window-mix fix is ON yet the source-stage anomaly persists and keeps its attribution.
  const s = await stats(page);
  expect(s.diagnostic.fixWindowMix).toBe(true);
  expect(s.mixMismatch!.attributedStage).toBe('source-overrun');
  await expect(page.locator('#mismatchStage')).toContainText('source-overrun');

  // Now enable only the source fix: overrun ledger entries disappear and the scan clears.
  await page.evaluate(() => window.__grain.app.postDiagnostic({ fixSourceOverrun: true }));
  await page.waitForFunction(
    () => window.__grain.app.getStats()?.mixMismatch === null,
    undefined,
    { timeout: 15000 },
  );
});

test('density drag distinguishes coherent loudness from a window fault', async ({ page }) => {
  // Healthy engine: dragging density changes level but never produces a mismatch.
  await page.evaluate(() => window.__grain.app.postDiagnosis(true));
  await page.getByRole('button', { name: '播放' }).click();
  await waitForSpawns(page, 10);

  await page.locator('#density').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const sparse = await stats(page);
  expect(sparse.mixMismatch).toBeNull();

  await page.locator('#density').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '150';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1600);
  const denseHealthy = await stats(page);
  expect(denseHealthy.mixMismatch).toBeNull();
  expect(denseHealthy.peakActive).toBeGreaterThan(sparse.peakActive);

  // Same drag under the window-normalisation fault now reports a window-stage mismatch.
  await page.evaluate(() =>
    window.__grain.app.postDiagnostic({ fixWindowMix: false, injectWindowNormError: true }),
  );
  await page.waitForFunction(
    () => window.__grain.app.getStats()?.mixMismatch?.attributedStage === 'window-mix',
    undefined,
    { timeout: 15000 },
  );
  const faulty = await stats(page);
  expect(faulty.mixMismatch!.attributedStage).toBe('window-mix');
});
