/** Real UI editing and native download checks in an isolated installed browser.
 * Only __LOCAL_CUT__.snapshot(), canvas pixels, and saved/downloaded data are read. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContext, probe, rgbFrame, color } from './native-helper';
const qa = await createContext(),
  screens = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
await mkdir(screens, { recursive: true });
const channel =
  process.env.EDITOR_QA_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined);
const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  acceptDownloads: true,
});
await context.addInitScript('window.__name=(target)=>target');
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [],
  consoleErrors: string[] = [],
  results: { name: string; pass: boolean; detail?: unknown; error?: string }[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('dialog', (d) => void d.accept());
const snap = () => page.evaluate(() => (window as any).__LOCAL_CUT__.snapshot());
const fill = async (id: string, value: string) => {
  await page.locator(`#${id}`).fill(value);
  await page.locator(`#${id}`).press('Tab');
};
const seek = async (t: number) => {
  await fill('playhead-time', String(t));
  await page.waitForTimeout(150);
};
const item = (kind: string, index: number) => page.locator(`.timeline-item.${kind}`).nth(index);
const add = async (name: string, kind: 'clip' | 'overlay' | 'audio') => {
  await page
    .locator('.media-card')
    .filter({ has: page.locator('strong', { hasText: name }) })
    .first()
    .getByRole('button', {
      name:
        kind === 'clip'
          ? `Add ${name} to main track`
          : kind === 'overlay'
            ? `Add ${name} as an overlay`
            : `Add ${name} as audio`,
      exact: true,
    })
    .click();
};
async function range(id: string, value: number) {
  const input = page.locator(`#${id}`);
  await input.press('Home');
  for (let i = 0; i < Math.round(value * 100); i++) await input.press('ArrowRight');
  await input.press('Tab');
}
async function ready() {
  await page.waitForFunction(
    () =>
      !(window as any).__LOCAL_CUT__.snapshot().importing &&
      !(document.getElementById('import-media') as HTMLButtonElement).disabled,
  );
}
async function saved() {
  await page.waitForFunction(
    () => document.getElementById('save-state')?.textContent === 'Saved on this computer',
  );
}
async function pixel(x = 0.5, y = 0.5) {
  return page.evaluate(
    ({ x, y }) => {
      const c = document.getElementById('preview-canvas') as HTMLCanvasElement;
      return Array.from(
        c.getContext('2d')!.getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1)
          .data,
      ).slice(0, 3);
    },
    { x, y },
  );
}
async function waitColor(expected: number[], x = 0.5, y = 0.5, tolerance = 15) {
  const began = Date.now();
  let got = await pixel(x, y);
  while (got.some((c, i) => Math.abs(c - expected[i]) > tolerance) && Date.now() - began < 5000) {
    await page.waitForTimeout(60);
    got = await pixel(x, y);
  }
  color(got, expected, 'preview pixel', tolerance);
  return got;
}
async function check(name: string, run: () => Promise<unknown>) {
  try {
    const detail = await run();
    results.push({ name, pass: true, detail });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, pass: false, error: String(e) });
    console.error(`FAIL ${name}: ${e}`);
    await page.screenshot({ path: join(screens, `failure-${results.length}.png`), fullPage: true });
    throw e;
  }
}
let fatal: string | undefined, projectFile: string | undefined;
try {
  await page.goto(qa.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      !!(window as any).__LOCAL_CUT__ &&
      !(document.getElementById('import-media') as HTMLButtonElement).disabled,
  );
  await check(
    'Studio launches with local media, working controls, and a compact desktop layout',
    async () => {
      assert.equal(await page.locator('#export-open').isDisabled(), true);
      assert.equal((await snap()).project.clips.length, 0);
      assert.ok((await snap()).media.length >= 7);
      const bounds = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        bottom: document.querySelector('.timeline-panel')!.getBoundingClientRect().bottom,
        height: innerHeight,
      }));
      assert.ok(bounds.scroll <= bounds.width);
      assert.ok(bounds.bottom <= bounds.height);
      await page.screenshot({ path: join(screens, 'studio-empty-desktop.png'), fullPage: true });
      return bounds;
    },
  );
  await check(
    'A real file import creates the first clip and adopts source canvas settings',
    async () => {
      await page.locator('#media-input').setInputFiles(qa.files['color-tone.mp4']);
      await ready();
      const s = await snap();
      assert.equal(s.project.clips.length, 1);
      assert.equal(s.project.width, 160);
      assert.equal(s.project.height, 90);
      assert.equal(s.project.fps, 30);
      await waitColor([255, 0, 0]);
      return { clip: s.project.clips[0], canvas: [s.project.width, s.project.height] };
    },
  );
  await check(
    'Canvas dimensions, source trim, speed, fit and original gain are editable',
    async () => {
      await page.locator('#project-settings').click();
      await fill('canvas-width', '320');
      await fill('canvas-height', '180');
      await page.locator('#canvas-fps').selectOption('30');
      await fill('project-title', 'QA Layered Edit');
      await item('clip', 0).click();
      await fill('clip-in', '.25');
      await fill('clip-out', '1.75');
      await fill('clip-speed', '1.5');
      await page.locator('#clip-fit').selectOption('cover');
      await range('clip-volume', 0.4);
      const s = await snap(),
        c = s.project.clips[0];
      assert.equal(c.in, 0.25);
      assert.equal(c.out, 1.75);
      assert.equal(c.speed, 1.5);
      assert.equal(c.volume, 0.4);
      assert.equal(c.fit, 'cover');
      assert.equal(s.project.width, 320);
      assert.equal(s.project.height, 180);
      await page.locator('#project-settings').click();
      await item('clip', 0).click();
      assert.equal(Number(await page.locator('#clip-volume').inputValue()), 0.4);
      return c;
    },
  );
  await check(
    'Split shortcut creates contiguous source cuts without changing duration',
    async () => {
      await seek(0.5);
      await page.locator('#preview-title').click();
      await page.keyboard.press('s');
      const s = await snap();
      assert.equal(s.project.clips.length, 2);
      assert.equal(s.project.clips[0].out, 1);
      assert.equal(s.project.clips[1].in, 1);
      assert.equal(await page.locator('#project-duration').innerText(), '00:01.000');
      return s.project.clips;
    },
  );
  await check(
    'Append, duplicate, reorder, ripple delete, undo and redo preserve clip identities',
    async () => {
      await add('green-24.mp4', 'clip');
      await fill('clip-out', '1.5');
      const original = (await snap()).project.clips.map((c: any) => c.id);
      await item('clip', 0).click();
      await page.locator('#duplicate').click();
      let s = await snap();
      const duplicated = s.selection.id;
      assert.equal(s.project.clips.length, 4);
      await page.locator('#move-right').click();
      assert.equal((await snap()).project.clips[2].id, duplicated);
      await page.locator('#undo').click();
      assert.equal((await snap()).project.clips[1].id, duplicated);
      await page.locator('#redo').click();
      assert.equal((await snap()).project.clips[2].id, duplicated);
      await page.locator('#delete').click();
      assert.deepEqual(
        (await snap()).project.clips.map((c: any) => c.id),
        original,
      );
      await page.locator('#preview-title').click();
      await page.keyboard.press('Control+z');
      assert.equal((await snap()).project.clips.length, 4);
      await page.keyboard.press('Control+Shift+z');
      assert.deepEqual(
        (await snap()).project.clips.map((c: any) => c.id),
        original,
      );
      return { original, duplicated };
    },
  );
  await check(
    'Seeking across actual cuts shows the right source frames in the composite preview',
    async () => {
      const samples = [];
      for (const [t, expected] of [
        [0.25, [255, 0, 0]],
        [0.75, [0, 0, 255]],
        [1.5, [0, 255, 0]],
      ] as const) {
        await seek(t);
        samples.push({ time: t, pixel: await waitColor([...expected]) });
      }
      return samples;
    },
  );
  await check(
    'Image layer timing, opacity, normalized position and preview drag/resize work',
    async () => {
      await seek(0.1);
      await add('transparency.png', 'overlay');
      await fill('layer-start', '.1');
      await fill('layer-duration', '2');
      await fill('layer-x', '10');
      await fill('layer-y', '10');
      await fill('layer-width', '40');
      await fill('layer-height', '40');
      await range('layer-opacity', 0.6);
      await fill('layer-fade-in', '.1');
      await fill('layer-fade-out', '.2');
      await seek(0.25);
      const blended = await waitColor([255, 77, 77], 0.18, 0.3, 12);
      const before = (await snap()).project.overlays[0],
        box = await page.locator('#selection-box').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.4 + 30, box.y + box.height * 0.5 + 10, {
        steps: 5,
      });
      await page.mouse.up();
      const moved = (await snap()).project.overlays[0];
      assert.ok(moved.x > before.x && moved.y > before.y);
      const handle = await page.locator('#resize-layer').boundingBox();
      assert.ok(handle);
      await page.mouse.move(handle.x + 5, handle.y + 5);
      await page.mouse.down();
      await page.mouse.move(handle.x + 30, handle.y + 20, { steps: 5 });
      await page.mouse.up();
      const resized = (await snap()).project.overlays[0];
      assert.ok(resized.width > moved.width && resized.height > moved.height);
      return { blended, before, moved, resized };
    },
  );
  await check(
    'Video overlays keep independent source timing, picture, sound and layer order',
    async () => {
      await seek(0.5);
      await add('overlay.mp4', 'overlay');
      await fill('layer-start', '.5');
      await fill('layer-duration', '1.5');
      await fill('layer-in', '.25');
      await fill('layer-x', '55');
      await fill('layer-y', '55');
      await fill('layer-width', '40');
      await fill('layer-height', '40');
      await range('layer-volume', 0.3);
      await fill('layer-fade-in', '.1');
      await fill('layer-fade-out', '.1');
      await seek(0.8);
      const yellow = await waitColor([255, 255, 0], 0.75, 0.75);
      await seek(1.4);
      const magenta = await waitColor([255, 0, 255], 0.75, 0.75);
      await page.getByRole('button', { name: 'Move back', exact: true }).click();
      let s = await snap();
      assert.equal(s.project.overlays[0].mediaId, qa.assets['overlay.mp4'].id);
      await page.getByRole('button', { name: 'Move forward', exact: true }).click();
      s = await snap();
      assert.equal(s.project.overlays[1].mediaId, qa.assets['overlay.mp4'].id);
      return { yellow, magenta };
    },
  );
  await check('Layer timeline dragging changes absolute start time and supports undo', async () => {
    const before = (await snap()).project.overlays[1].start,
      box = await item('overlay', 1).boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 15, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + 47, box.y + 15, { steps: 5 });
    await page.mouse.up();
    const after = (await snap()).project.overlays[1].start;
    assert.ok(after > before + 0.4);
    await page.locator('#undo').click();
    assert.equal((await snap()).project.overlays[1].start, before);
    return { before, after };
  });
  await check(
    'Multiple audio layers expose independent timing, offsets, loops, gains and fades',
    async () => {
      await seek(0.1);
      await add('music-880.wav', 'audio');
      await fill('layer-start', '.1');
      await fill('layer-duration', '2.4');
      await fill('layer-in', '2.5');
      await range('layer-volume', 0.5);
      await fill('layer-fade-in', '.1');
      await fill('layer-fade-out', '.2');
      await seek(0.5);
      await add('music-660.wav', 'audio');
      await fill('layer-start', '.5');
      await fill('layer-duration', '1.5');
      await fill('layer-in', '1');
      await range('layer-volume', 0.2);
      await page.locator('#audio-loop').uncheck();
      await fill('layer-fade-in', '.1');
      await fill('layer-fade-out', '.1');
      const audio = (await snap()).project.audio;
      assert.equal(audio.length, 2);
      assert.equal(audio[0].loop, true);
      assert.equal(audio[1].loop, false);
      assert.equal(audio[0].in, 2.5);
      assert.equal(audio[1].volume, 0.2);
      await item('audio', 0).click();
      assert.equal(Number(await page.locator('#layer-volume').inputValue()), 0.5);
      await item('audio', 1).click();
      assert.equal(Number(await page.locator('#layer-volume').inputValue()), 0.2);
      return audio;
    },
  );
  await check(
    'Playback crosses cuts and synchronizes active video and multiple audio sources',
    async () => {
      await seek(0);
      await page.locator('#play').click();
      await page.waitForFunction(() => (window as any).__LOCAL_CUT__.snapshot().time > 1.35);
      const s = await snap();
      assert.equal(s.playing, true);
      const music = s.preview.elements.find((e: any) => e.id === s.project.audio[0].id),
        expected = (2.5 + s.time - 0.1) % 3;
      assert.ok(music && !music.paused);
      assert.ok(Math.abs(music.time - expected) < 0.22, JSON.stringify({ music, expected }));
      const green = s.preview.elements.find((e: any) => e.id === s.project.clips[2].id);
      assert.ok(green && !green.paused);
      assert.ok(Math.abs(green.time - (s.time - 1)) < 0.22);
      await page.waitForFunction(() => !(window as any).__LOCAL_CUT__.snapshot().playing);
      const end = await snap();
      assert.equal(end.time, 2.5);
      await seek(1.4);
      await page.screenshot({ path: join(screens, 'studio-layered-desktop.png'), fullPage: true });
      return { time: s.time, music, expectedMusicTime: expected, green, endTime: end.time };
    },
  );
  await check('Autosave survives a reload with all clip and layer settings intact', async () => {
    await saved();
    const before = (await snap()).project;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(
      () =>
        !!(window as any).__LOCAL_CUT__ &&
        (window as any).__LOCAL_CUT__.snapshot().project.title === 'QA Layered Edit',
    );
    assert.deepEqual((await snap()).project, before);
    return {
      projectId: before.id,
      clips: before.clips.length,
      overlays: before.overlays.length,
      audio: before.audio.length,
    };
  });
  await check(
    'Project files contain editable cuts and media references, and missing sources can be relinked',
    async () => {
      const event = page.waitForEvent('download');
      await page.locator('#save-project').click();
      const download = await event;
      projectFile = join(qa.dir, 'saved-project.json');
      await download.saveAs(projectFile);
      const document = JSON.parse(await readFile(projectFile, 'utf8'));
      assert.equal(document.project.version, 2);
      assert.ok(document.media.length >= 5);
      const old = document.project.clips[0].mediaId,
        newId = randomUUID();
      document.project.id = randomUUID();
      document.project.title = 'QA Relinked Edit';
      for (const clip of document.project.clips) if (clip.mediaId === old) clip.mediaId = newId;
      for (const media of document.media) if (media.id === old) media.id = newId;
      await page.locator('#project-input').setInputFiles({
        name: 'portable.localcut.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(document)),
      });
      await page.locator('#missing-banner').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#play').isDisabled(), true);
      assert.equal(await page.locator('#export-open').isDisabled(), true);
      await page.locator('#relink-open').click();
      await page.getByRole('button', { name: 'Choose file', exact: true }).click();
      await page.locator('#relink-input').setInputFiles(qa.files['color-tone.mp4']);
      await ready();
      assert.deepEqual((await snap()).missing, []);
      assert.equal(await page.locator('#play').isEnabled(), true);
      assert.equal(await page.locator('#relink-dialog').isVisible(), false);
      const p = (await snap()).project;
      assert.notEqual(p.clips[0].mediaId, newId);
      assert.equal(p.clips[0].mediaId, p.clips[1].mediaId);
      return {
        file: download.suggestedFilename(),
        referenceCount: document.media.length,
        relinked: p.clips[0].mediaId,
      };
    },
  );
  await check(
    'The full layered edit exports and downloads a real MP4 with the expected cuts',
    async () => {
      const before = (await snap()).project;
      await page.locator('#export-open').click();
      await fill('export-name', 'layered-browser-qa');
      const requested = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().endsWith('/api/exports'),
      );
      await page.locator('#export-start').click();
      const payload = (await requested).postDataJSON();
      assert.deepEqual(payload.project, before);
      await page.locator('#download').waitFor({ state: 'visible', timeout: 60000 });
      const event = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await event,
        path = join(qa.dir, 'ui-composite.mp4');
      await download.saveAs(path);
      const info = await probe(path),
        v = info.streams.find((s: any) => s.codec_type === 'video');
      assert.equal(v.width, 320);
      assert.equal(v.height, 180);
      assert.equal(v.avg_frame_rate, '30/1');
      assert.equal(Number(v.nb_read_frames), 75);
      assert.ok(Math.abs(Number(info.format.duration) - 2.5) < 0.025);
      const samples = [];
      for (const [frame, expected] of [
        [7, [255, 0, 0]],
        [22, [0, 0, 255]],
        [45, [0, 255, 0]],
      ] as const) {
        const rgb = await rgbFrame(path, frame),
          at = (10 * 320 + 160) * 3,
          value = Array.from(rgb.subarray(at, at + 3));
        color(value, [...expected], `export frame ${frame}`);
        samples.push({ frame, pixel: value });
      }
      assert.ok(info.streams.some((s: any) => s.codec_type === 'audio'));
      await page.screenshot({ path: join(screens, 'studio-export-complete.png'), fullPage: true });
      await page.locator('#export-close').click();
      return {
        filename: download.suggestedFilename(),
        duration: info.format.duration,
        frames: v.nb_read_frames,
        samples,
      };
    },
  );
  await check(
    'Double-clicking export creates one job; composition cancellation leaves editing available',
    async () => {
      await page.locator('#export-open').click();
      let submissions = 0;
      const count = (r: any) => {
        if (r.method() === 'POST' && r.url().endsWith('/api/exports')) submissions++;
      };
      page.on('request', count);
      await page.route('**/api/projects/*', async (route) => {
        if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 250));
        await route.continue();
      });
      try {
        const box = await page.locator('#export-start').boundingBox();
        assert.ok(box);
        await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 });
        await page.waitForFunction(
          () => !(document.getElementById('export-cancel') as HTMLButtonElement).disabled,
        );
        await page.locator('#export-cancel').click();
        await page.waitForFunction(
          () => document.getElementById('job-title')?.textContent === 'Export cancelled',
        );
        assert.equal(submissions, 1);
        assert.equal(await page.locator('#download').isVisible(), false);
        await page.locator('#export-close').click();
        assert.equal(await page.locator('#play').isEnabled(), true);
        return { cancelled: true, submissions };
      } finally {
        await page.unroute('**/api/projects/*');
        page.off('request', count);
      }
    },
  );
  await check('Invalid media gives a clear error without discarding the current edit', async () => {
    const before = (await snap()).project;
    await page.locator('#media-input').setInputFiles({
      name: 'invalid.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('not media'),
    });
    await page.locator('#message').waitFor({ state: 'visible' });
    await ready();
    assert.deepEqual((await snap()).project, before);
    const message = await page.locator('#message-text').innerText();
    await page.locator('#message-close').click();
    return { message };
  });
  await check(
    'Project list, new project and reopening saved edits work through the UI',
    async () => {
      await saved();
      const prior = (await snap()).project;
      await page.locator('#projects').click();
      await page.locator('#new-project').click();
      await page.locator('#projects-dialog').waitFor({ state: 'hidden' });
      assert.equal((await snap()).project.clips.length, 0);
      await page.locator('#projects').click();
      await page.locator('.project-row').filter({ hasText: 'QA Relinked Edit' }).click();
      await page.locator('#projects-dialog').waitFor({ state: 'hidden' });
      assert.deepEqual((await snap()).project, prior);
      return { restored: prior.id };
    },
  );
  await check(
    'Save failures block project replacement and retain the unsaved in-memory edit',
    async () => {
      await saved();
      await page.route('**/api/projects/*', async (route) => {
        if (route.request().method() === 'PUT')
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Deliberate QA save failure' }),
          });
        else await route.continue();
      });
      try {
        await fill('project-title', 'Unsaved QA edit');
        const before = (await snap()).project;
        await page.locator('#projects').click();
        await page.waitForFunction(
          () => document.getElementById('save-state')?.textContent === 'Could not save',
        );
        assert.equal(await page.locator('#projects-dialog').isVisible(), false);
        assert.deepEqual((await snap()).project, before);
        assert.match(await page.locator('#message-text').innerText(), /Autosave failed/);
        return { projectRetained: before.id };
      } finally {
        await page.unroute('**/api/projects/*');
        await page.locator('#message-close').click();
        await fill('project-title', 'QA Relinked Edit');
        await saved();
      }
    },
  );
  await check(
    'Space plays after a workspace button; released outside drags do not remain active',
    async () => {
      await seek(0.25);
      await page.locator('#project-settings').click();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => (window as any).__LOCAL_CUT__.snapshot().playing);
      await page.keyboard.press('Space');
      await page.waitForFunction(() => !(window as any).__LOCAL_CUT__.snapshot().playing);
      await seek(0.25);
      await item('overlay', 0).click();
      const before = (await snap()).project.overlays[0],
        box = await page.locator('#selection-box').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(-25, -25, { steps: 4 });
      await page.mouse.up();
      const released = (await snap()).project.overlays[0];
      await page.mouse.move(600, 250, { steps: 4 });
      assert.deepEqual((await snap()).project.overlays[0], released);
      await page.locator('#undo').click();
      assert.deepEqual((await snap()).project.overlays[0], before);
      return { spacePlayback: true, releasedDragRetained: true };
    },
  );
  await check(
    'Portrait and square canvas presets, frame stepping and zoom remain functional',
    async () => {
      await page.locator('#project-settings').click();
      await page.locator('#canvas-shape').selectOption('portrait');
      assert.equal((await snap()).project.width, 1080);
      assert.equal((await snap()).project.height, 1920);
      await page.locator('#canvas-shape').selectOption('square');
      assert.equal((await snap()).project.width, (await snap()).project.height);
      await page.locator('#undo').click();
      await page.locator('#undo').click();
      await seek(0);
      await page.locator('#frame-forward').click();
      assert.ok(Math.abs((await snap()).time - 1 / 30) < 1e-9);
      await page.locator('#frame-back').click();
      assert.equal((await snap()).time, 0);
      await page.locator('#zoom-fit').click();
      assert.ok(Number(await page.locator('#timeline-zoom').inputValue()) > 64);
      return { frameStep: true, zoom: await page.locator('#timeline-zoom').inputValue() };
    },
  );
  await check(
    'Narrow layouts keep the preview, library, inspector and timeline accessible',
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await seek(1.4);
      await item('overlay', 0).click();
      await page.waitForTimeout(120);
      const bounds = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(bounds.scroll <= bounds.width, JSON.stringify(bounds));
      await page.screenshot({ path: join(screens, 'studio-mobile.png'), fullPage: true });
      await page.locator('#export-open').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#export-open').isEnabled(), true);
      await page.setViewportSize({ width: 1440, height: 960 });
      return bounds;
    },
  );
  assert.deepEqual(errors, []);
  await saved();
} catch (e) {
  fatal = String(e);
  console.error(e);
} finally {
  await writeFile(
    fileURLToPath(new URL('./browser-results.json', import.meta.url)),
    JSON.stringify(
      {
        created: new Date().toISOString(),
        browser: await browser.version(),
        isolated: true,
        method:
          'Normal UI interactions, read-only snapshots/canvas pixels, saved JSON and independently decoded export frames.',
        results,
        errors,
        consoleErrors,
        fatal,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await qa.close();
}
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    errors,
    fatal,
  }),
);
if (fatal || errors.length || results.some((r) => !r.pass)) process.exitCode = 1;
