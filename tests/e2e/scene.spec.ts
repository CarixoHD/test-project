import { expect, test, type Page } from '@playwright/test';

// Scene3D smoke test on the production build: the lazy 3D view mounts a canvas, stays under
// the draw-call budget while the demo pipeline builds a product, and stops rendering when the
// panel is collapsed. Render stats come from `window.__vibecodeScene`, which the production
// build only exposes with the `vibecode.debug.sceneStats` localStorage flag.

const SCENE_STATS_FLAG = 'vibecode.debug.sceneStats';
const SCENE_COLLAPSED_KEY = 'vibecode.scene.collapsed';
const DRAW_CALL_BUDGET = 60;
const PIPELINE_TIMEOUT_MS = 120_000;

/** Shape of the probe in src/web/scene/Scene3D.tsx (StatsProbe). */
interface SceneStats {
  drawCalls: number;
  triangles: number;
  frames: number;
  workers: number;
  pieces: number;
}

/** Peaks over every frame the probe reported, kept by the init script below. */
interface ScenePeaks {
  drawCalls: number;
  workers: number;
}

declare global {
  interface Window {
    __vibecodeScene?: SceneStats;
    __e2eScenePeaks?: ScenePeaks;
  }
}

const readStats = (page: Page): Promise<SceneStats | null> =>
  page.evaluate(() =>
    window.__vibecodeScene === undefined ? null : { ...window.__vibecodeScene },
  );

/** Frames drawn so far (0 before the first frame). */
const frames = async (page: Page): Promise<number> => (await readStats(page))?.frames ?? 0;

test('the 3D view renders under the draw-call budget and stops when collapsed', async ({
  page,
  request,
}) => {
  // Create a product and hand a PRD straight to the orchestrator, so the scene fills up.
  const name = `Scene check ${String(Date.now())}`;
  const created = await request.post('/api/products', {
    data: { name, idea: 'Track daily habits and show streaks.' },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const draft = await request.put(`/api/products/${id}/prd-draft`, {
    data: { markdown: '# Habit tracker\n\nTrack daily habits and show the current streak.\n' },
  });
  expect(draft.ok()).toBe(true);

  await page.addInitScript(
    ([flag, collapsedKey]) => {
      localStorage.setItem(flag, '1');
      localStorage.setItem(collapsedKey, 'false');
      // The probe writes its stats once per frame. Demo agents can come and go between two
      // polls from the test, so record the peaks of every frame here, in the page.
      const peaks: ScenePeaks = { drawCalls: 0, workers: 0 };
      let current: SceneStats | undefined;
      window.__e2eScenePeaks = peaks;
      Object.defineProperty(window, '__vibecodeScene', {
        configurable: true,
        get: () => current,
        set: (stats: SceneStats | undefined) => {
          current = stats;
          if (stats === undefined) return;
          peaks.drawCalls = Math.max(peaks.drawCalls, stats.drawCalls);
          peaks.workers = Math.max(peaks.workers, stats.workers);
        },
      });
    },
    [SCENE_STATS_FLAG, SCENE_COLLAPSED_KEY] as const,
  );
  await page.goto(`/products/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const panel = page.getByRole('region', { name: '3D view' });
  const toggle = panel.getByRole('button', { name: '3D view' });
  const canvas = panel.locator('canvas');
  await panel.scrollIntoViewIfNeeded();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => frames(page), { timeout: 30_000 }).toBeGreaterThan(0);

  const handoff = await request.post(`/api/products/${id}/handoff`, { data: {} });
  expect(handoff.ok(), await handoff.text()).toBe(true);

  // Let the pipeline run: workers come and go (peaks recorded per frame), pieces pile up.
  await expect(page.getByRole('heading', { level: 3, name: 'Completed (3)' })).toBeVisible({
    timeout: PIPELINE_TIMEOUT_MS,
  });
  await expect.poll(async () => (await readStats(page))?.pieces ?? 0, { timeout: 30_000 }).toBe(3);
  const final = await readStats(page);
  const peaks = await page.evaluate(() => ({ ...window.__e2eScenePeaks }));
  test.info().annotations.push({ type: 'max draw calls', description: String(peaks.drawCalls) });
  expect(peaks.workers, 'some frame showed working figures').toBeGreaterThan(0);
  expect(final?.drawCalls).toBeGreaterThan(0);
  expect(peaks.drawCalls).toBeLessThan(DRAW_CALL_BUDGET);

  // Collapse: the canvas is hidden and no more frames are drawn.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(canvas).toBeHidden();
  const collapsedAt = await frames(page);
  await page.waitForTimeout(1_000);
  expect(await frames(page)).toBe(collapsedAt);

  // Expanding again resumes rendering on the same, still-mounted canvas.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(canvas).toBeVisible();
  await expect.poll(() => frames(page)).toBeGreaterThan(collapsedAt);
});
