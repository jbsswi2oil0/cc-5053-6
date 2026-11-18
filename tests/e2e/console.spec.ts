import { expect, test } from '@playwright/test';

interface Stats {
  playing: boolean;
  paused: boolean;
  spawnCount: number;
  measuredDensity: number;
  requestedDensity: number;
  currentActive: number;
  peakActive: number;
  capacity: number;
  dropped: number;
  outOfRangeReads: number;
  nanSamples: number;
  windowEdgeMax: number;
  renderedFrames: number;
  continuity: number;
  analysisWindows: number;
  recordFrames: number;
  sampleRate: number;
  peak: number;
  sessionSeconds: number;
}

declare global {
  interface Window {
    __grain: {
      app: {
        getStats(): Stats | null;
        setParam(key: string, value: number | string): void;
        play(): Promise<void>;
        stop(): Promise<void>;
      };
    };
  }
}

async function stats(page: import('@playwright/test').Page): Promise<Stats | null> {
  return page.evaluate(() => window.__grain?.app.getStats() ?? null);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?test');
  await expect(page.locator('body')).toHaveAttribute('data-panel-ready', 'true');
});

test('plays a sample-accurate grain cloud and reports real grains', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(() => {
    const s = window.__grain?.app.getStats();
    return !!s && s.playing && s.spawnCount > 12;
  });
  const s = (await stats(page))!;
  expect(s.sampleRate).toBeGreaterThan(8000);
  expect(s.currentActive).toBeGreaterThan(0);
  expect(s.currentActive).toBeLessThanOrEqual(s.capacity);
  expect(s.spawnCount).toBeGreaterThan(12);
  expect(s.outOfRangeReads).toBe(0);
  expect(s.nanSamples).toBe(0);
  expect(s.windowEdgeMax).toBeLessThan(1e-5);
  expect(s.peak).toBeLessThan(0.99);
  expect(s.measuredDensity).toBeGreaterThan(4);

  await expect(page.locator('#anomalyCount')).toHaveText(/正常|提示/);
  await expect(page.locator('#activeVal')).not.toHaveText('0');
  await expect(page.locator('#metricWindow')).toHaveText(/^0\.000/);

  await page.waitForTimeout(1200);
  await expect(page.locator('#continuityVal')).toHaveText(/%/);
});

test('density control changes measured density and grain counts', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(() => {
    const s = window.__grain?.app.getStats();
    return !!s && s.spawnCount > 10;
  });

  await page.locator('#density').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '8';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__grain?.app.getStats()?.requestedDensity === 8);
  await page.waitForTimeout(2200);
  const sparse = (await stats(page))!;

  await page.locator('#density').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '120';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__grain?.app.getStats()?.requestedDensity === 120);
  await page.waitForTimeout(2500);
  const dense = (await stats(page))!;

  expect(sparse.requestedDensity).toBe(8);
  expect(dense.requestedDensity).toBe(120);
  expect(dense.measuredDensity).toBeGreaterThan(sparse.measuredDensity * 2.5);
  expect(dense.measuredDensity).toBeGreaterThan(70);
  expect(dense.measuredDensity).toBeLessThan(140);
  expect(dense.peakActive).toBeGreaterThan(sparse.peakActive);
  expect(dense.currentActive).toBeLessThanOrEqual(dense.capacity);
  expect(dense.peak).toBeLessThan(0.99);

  await expect(page.locator('#measuredVal')).toHaveText(/\/s/);
  await expect(page.locator('#grainSpawned')).not.toHaveText('0');
});

test('pauses, keeps engine time advancing, and resumes', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(() => (window.__grain?.app.getStats()?.spawnCount ?? 0) > 8);

  await page.getByRole('button', { name: '暂停' }).click();
  await page.waitForFunction(() => window.__grain?.app.getStats()?.paused === true);
  const pausedA = (await stats(page))!;
  await page.waitForTimeout(900);
  const pausedB = (await stats(page))!;
  expect(pausedB.renderedFrames).toBeGreaterThan(pausedA.renderedFrames);
  expect(pausedB.currentActive).toBe(0);

  await page.getByRole('button', { name: '继续' }).click();
  await page.waitForFunction(() => window.__grain?.app.getStats()?.paused === false);
  const beforeResumeCount = (await stats(page))!.spawnCount;
  await page.waitForTimeout(900);
  const resumed = (await stats(page))!;
  expect(resumed.spawnCount).toBeGreaterThan(beforeResumeCount);
  expect(resumed.currentActive).toBeGreaterThan(0);
});

test('audio time advances without requestAnimationFrame', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(
    () => (window.__grain?.app.getStats()?.spawnCount ?? 0) > 10,
    undefined,
    { polling: 100 },
  );
  const a = (await stats(page))!;

  // Freeze the presentation loop entirely: the worklet and its telemetry must
  // keep advancing on the audio clock, independent of UI refresh.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  await page.waitForTimeout(1200);
  const b = (await stats(page))!;
  expect(b.renderedFrames).toBeGreaterThan(a.renderedFrames + 30000);
  expect(b.spawnCount).toBeGreaterThan(a.spawnCount);
  expect(b.playing).toBe(true);
  expect(b.currentActive).toBeGreaterThan(0);
});

test('records real output and finalizes a downloadable wav', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(() => (window.__grain?.app.getStats()?.spawnCount ?? 0) > 8);

  await page.getByRole('button', { name: '录制' }).click();
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: '停止录制' }).click();
  await expect(page.locator('#downloadBtn')).toHaveAttribute('href', /^blob:/, { timeout: 10_000 });
  await expect(page.locator('#downloadBtn')).toHaveText(/下载录音 \(\d/);
  await expect(page.locator('#recStatus')).toHaveText(/录音：完成/);

  const href = await page.locator('#downloadBtn').getAttribute('href');
  const bytes = await page.evaluate(async (url) => {
    const res = await fetch(url!);
    const buf = await res.arrayBuffer();
    return buf.byteLength;
  }, href);
  expect(bytes).toBeGreaterThan(44 + 48000);
});

test('handles hostile parameter values without anomalies', async ({ page }) => {
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(() => (window.__grain?.app.getStats()?.spawnCount ?? 0) > 5);
  await page.evaluate(() => {
    const app = window.__grain.app;
    app.setParam('readSpeed', 8);
    app.setParam('positionJitter', 1);
    app.setParam('position', 1);
    app.setParam('grainDuration', 0.005);
    app.setParam('durationJitter', 0.9);
    app.setParam('density', 200);
  });
  await page.waitForTimeout(1800);
  const s = (await stats(page))!;
  expect(s.outOfRangeReads).toBe(0);
  expect(s.nanSamples).toBe(0);
  expect(s.peak).toBeLessThan(0.99);
  await expect(page.locator('#metricOob')).toHaveText('0');
  await expect(page.locator('#metricNan')).toHaveText('0');
});

test('switch materials and edge policies through the console', async ({ page }) => {
  for (const material of ['impulse', 'transient', 'steady']) {
    await page.locator(`[data-material="${material}"]`).click();
    await expect(page.locator(`[data-material="${material}"]`)).toHaveClass(/active/);
    await expect(page.locator('#sourceMeta')).toContainText(material);
  }
  await page.locator('[data-boundary="loop"]').click();
  await expect(page.locator('[data-boundary="loop"]')).toHaveClass(/active/);
  await page.getByRole('button', { name: '播放' }).click();
  await page.waitForFunction(() => (window.__grain?.app.getStats()?.spawnCount ?? 0) > 10);
  await page.waitForTimeout(900);
  const s = (await stats(page))!;
  expect(s.outOfRangeReads).toBe(0);
  expect(s.nanSamples).toBe(0);
  await page.locator('[data-boundary="clip"]').click();
  await expect(page.locator('[data-boundary="clip"]')).toHaveClass(/active/);
  await expect(page.locator('#policyNote')).toContainText('截取');
});
