/** Isolated installed-browser QA through normal editor controls. Generated local
 * media and a disposable local server; no user browser/profile is attached. */
import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createQaContext, native } from './editor-qa';
const require = createRequire(import.meta.url),
  ffmpeg = require('ffmpeg-static') as string,
  ffprobe = (require('ffprobe-static') as { path: string }).path;
const qa = await createQaContext(),
  screens = 'docs/screenshots/legacy';
await mkdir(screens, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.EDITOR_QA_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  acceptDownloads: true,
});
await context.addInitScript('window.__name=(target)=>target');
const page = await context.newPage(),
  errors: string[] = [],
  consoleErrors: string[] = [],
  results: { name: string; pass: boolean; detail?: unknown; error?: string }[] = [];
page.setDefaultTimeout(15000);
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
const media = () =>
  page.evaluate(() => {
    const v = document.querySelector('video')!,
      a = document.querySelector('audio')!;
    return {
      video: {
        time: v.currentTime,
        duration: v.duration,
        paused: v.paused,
        volume: v.volume,
        ready: v.readyState,
        src: v.currentSrc,
      },
      music: {
        time: a.currentTime,
        duration: a.duration,
        paused: a.paused,
        volume: a.volume,
        loop: a.loop,
        src: a.currentSrc,
      },
    };
  });
const fill = async (id: string, value: string) => {
  await page.locator(`#${id}`).fill(value);
  await page.locator(`#${id}`).press('Tab');
};
async function ready() {
  await page.waitForFunction(() => !document.getElementById('upload-overlay')!.checkVisibility());
  await page.waitForFunction(
    () => !(document.getElementById('export') as HTMLButtonElement).disabled,
  );
}
async function setRange(id: string, value: number) {
  const control = page.locator(`#${id}`);
  await control.press('Home');
  for (let i = 0; i < Math.round(value * 100); i++) await control.press('ArrowRight');
  await control.press('Tab');
}
async function check(name: string, run: () => Promise<unknown>) {
  try {
    const detail = await run();
    results.push({ name, pass: true, detail });
    console.log(`PASS ${name}`);
  } catch (cause) {
    results.push({ name, pass: false, error: String(cause) });
    console.error(`FAIL ${name}: ${cause}`);
    await page.screenshot({ path: `${screens}/failure-${results.length}.png`, fullPage: true });
  }
}
let fatal: string | undefined;
try {
  await page.goto(qa.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => !(document.getElementById('choose-video') as HTMLButtonElement).disabled,
  );
  await check(
    'Local launch is ready, empty controls are safe, and desktop layout fits',
    async () => {
      assert.equal(await page.locator('#export').isDisabled(), true);
      assert.equal(await page.locator('#add-music').isDisabled(), true);
      assert.match(await page.locator('#connection-status').innerText(), /ready/);
      const dimensions = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
        trimBottom: document.querySelector('.trim-card')!.getBoundingClientRect().bottom,
        viewport: innerHeight,
      }));
      assert.ok(dimensions.scroll <= dimensions.width);
      assert.ok(dimensions.trimBottom < dimensions.viewport, JSON.stringify(dimensions));
      await page.screenshot({ path: `${screens}/desktop-empty.png`, fullPage: true });
      return dimensions;
    },
  );
  await check(
    'Opening a local video probes duration, enables editing, and preserves audio',
    async () => {
      await page.locator('#video-file-input').setInputFiles(qa.videoPath);
      await ready();
      await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
      const m = await media();
      assert.ok(Math.abs(m.video.duration - 6) < 0.025);
      assert.equal(m.video.paused, true);
      assert.equal(m.video.volume, 1);
      assert.equal(await page.locator('#trim-start').inputValue(), '00:00.000');
      assert.equal(await page.locator('#trim-end').inputValue(), '00:06.000');
      return m;
    },
  );
  await check(
    'Precise trim entries, dual drag handles, and keyboard handles set real bounds',
    async () => {
      await fill('trim-start', '1.200');
      await fill('trim-end', '00:04.200');
      assert.equal(await page.locator('#clip-length').innerText(), '00:03.000');
      await page.locator('#in-handle').press('ArrowRight');
      assert.equal(await page.locator('#trim-start').inputValue(), '00:01.233');
      const handle = await page.locator('#in-handle').boundingBox(),
        rail = await page.locator('#timeline').boundingBox();
      assert.ok(handle && rail);
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(rail.x + rail.width / 6, rail.y + rail.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.ok(
        Math.abs(Number(await page.locator('#in-handle').getAttribute('aria-valuenow')) - 1) <
          0.025,
      );
      await fill('trim-start', 'invalid');
      assert.equal(await page.locator('#error').isVisible(), true);
      await page.locator('#dismiss-error').click();
      await fill('trim-start', '0.500');
      await fill('trim-end', '4.500');
      return {
        start: await page.locator('#trim-start').inputValue(),
        end: await page.locator('#trim-end').inputValue(),
      };
    },
  );
  await check(
    'Scrubbing and I/O shortcuts use the playhead; typing does not trigger shortcuts',
    async () => {
      const rail = await page.locator('#scrub').boundingBox();
      assert.ok(rail);
      await page.locator('#scrub').click({ position: { x: rail.width * 0.3, y: rail.height / 2 } });
      await page.locator('h1').click();
      await page.keyboard.press('i');
      const setIn = Number(await page.locator('#in-handle').getAttribute('aria-valuenow'));
      assert.ok(setIn > 1.7 && setIn < 1.9);
      await page.locator('#scrub').click({ position: { x: rail.width * 0.6, y: rail.height / 2 } });
      await page.locator('h1').click();
      await page.keyboard.press('o');
      const setOut = Number(await page.locator('#out-handle').getAttribute('aria-valuenow'));
      assert.ok(setOut > 3.5 && setOut < 3.7);
      await page.locator('#filename').fill('io test');
      assert.equal(Number(await page.locator('#in-handle').getAttribute('aria-valuenow')), setIn);
      assert.equal(Number(await page.locator('#out-handle').getAttribute('aria-valuenow')), setOut);
      await fill('trim-start', '0.500');
      await fill('trim-end', '4.500');
      return { setIn, setOut };
    },
  );
  await check(
    'Music import, gain, offset and whole-track loop preview follow the edit',
    async () => {
      await page.locator('#music-file-input').setInputFiles(qa.musicPath);
      await ready();
      await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 2);
      await setRange('video-volume', 0.4);
      await setRange('music-volume', 0.5);
      await fill('music-offset', '1.500');
      await fill('fade-in', '0.4');
      await fill('fade-out', '0.5');
      await page.locator('#loop-music').check();
      await page.locator('#scrub').press('Home');
      await page.locator('#play').click();
      await page.waitForTimeout(1950);
      const m = await media(),
        elapsed = m.video.time - 0.5,
        expected = (1.5 + elapsed) % 3;
      assert.equal(m.video.paused, false);
      assert.equal(m.music.paused, false);
      assert.ok(Math.abs(m.music.time - expected) < 0.25, JSON.stringify({ m, expected }));
      assert.equal(m.video.volume, 0.4);
      assert.ok(Math.abs(m.music.volume - 0.5) < 0.001);
      await page.locator('#play').click();
      return { ...m, expectedMusicTime: expected, tolerance: 0.25 };
    },
  );
  await check(
    'Non-loop music fades at its audible end; selection playback stops at Out',
    async () => {
      await page.locator('#loop-music').uncheck();
      await page.locator('#scrub').press('Home');
      await page.locator('#play').click();
      await page.waitForTimeout(1260);
      const m = await media(),
        elapsed = m.video.time - 0.5,
        expected = 0.5 * Math.max(0, Math.min(1, (1.5 - elapsed) / 0.5));
      assert.ok(Math.abs(m.music.volume - expected) < 0.07, JSON.stringify({ m, expected }));
      await page.waitForFunction(() => document.querySelector('video')!.paused, undefined, {
        timeout: 6000,
      });
      const end = await media();
      assert.ok(Math.abs(end.video.time - 4.5) < 0.025);
      assert.equal(end.music.paused, true);
      return { fadeSample: m, expectedVolume: expected, end };
    },
  );
  await check(
    'Export sends the UI edit, exposes progress, and downloads a real trimmed MP4',
    async () => {
      await fill('filename', 'editor-browser-check');
      await page.locator('#quality').selectOption('compact');
      await page.locator('#loop-music').check();
      const request = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().endsWith('/api/exports'),
      );
      await page.locator('#export').click();
      const payload = (await request).postDataJSON();
      assert.equal(payload.start, 0.5);
      assert.equal(payload.end, 4.5);
      assert.equal(payload.videoVolume, 0.4);
      assert.equal(payload.musicVolume, 0.5);
      assert.equal(payload.musicOffset, 1.5);
      assert.equal(payload.fadeIn, 0.4);
      assert.equal(payload.fadeOut, 0.5);
      assert.equal(payload.loopMusic, true);
      assert.equal(payload.quality, 'compact');
      await page.locator('#download').waitFor({ state: 'visible', timeout: 60000 });
      assert.equal(await page.locator('#export-progress').getAttribute('value'), '1');
      assert.equal(await page.locator('#job-title').innerText(), 'Your clip is ready');
      const downloadEvent = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await downloadEvent,
        path = join(qa.dir, 'browser-download.mp4');
      await download.saveAs(path);
      const info = JSON.parse(
        (
          await native(ffprobe, [
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            path,
          ])
        ).toString(),
      );
      assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.025);
      const stream = info.streams.find((s: any) => s.codec_type === 'video');
      assert.equal(stream.width, 320);
      assert.equal(stream.height, 180);
      assert.equal(stream.codec_name, 'h264');
      assert.ok(info.streams.some((s: any) => s.codec_type === 'audio'));
      await page.screenshot({ path: `${screens}/desktop-edited.png`, fullPage: true });
      return { payload, download: download.suggestedFilename(), duration: info.format.duration };
    },
  );
  await check(
    'Changing an edit labels its old download, and short selections clamp fades safely',
    async () => {
      await fill('trim-end', '0.700');
      assert.equal(await page.locator('#job-title').innerText(), 'Previous export');
      assert.ok(Number(await page.locator('#fade-in').inputValue()) <= 0.200001);
      assert.ok(Number(await page.locator('#fade-out').inputValue()) <= 0.200001);
      await fill('trim-start', '0.500');
      await fill('trim-end', '4.500');
      await fill('fade-in', '0.4');
      await fill('fade-out', '0.5');
      return { previousExportLabel: true };
    },
  );
  await check('Invalid imports show an error and retain the current usable edit', async () => {
    const old = (await media()).video.src;
    await page.locator('#video-file-input').setInputFiles({
      name: 'invalid.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('Not a media file'),
    });
    await page.locator('#error').waitFor({ state: 'visible' });
    await ready();
    assert.equal((await media()).video.src, old);
    assert.equal(await page.locator('#trim-start').inputValue(), '00:00.500');
    await page.locator('#dismiss-error').click();
    return { previousVideoRetained: true };
  });
  await check(
    'Replacing video resets trim only and removes the old local working copy',
    async () => {
      const old = (await media()).video.src;
      await page.locator('#video-file-input').setInputFiles(qa.videoPath);
      await ready();
      assert.equal(await page.locator('#trim-start').inputValue(), '00:00.000');
      assert.equal(await page.locator('#trim-end').inputValue(), '00:06.000');
      assert.equal(await page.locator('#music-volume').inputValue(), '0.5');
      assert.equal(await page.locator('#video-volume').inputValue(), '0.4');
      assert.equal(await page.locator('#music-offset').inputValue(), '00:01.500');
      assert.equal(await page.locator('#music-file').isVisible(), true);
      await page.waitForTimeout(100);
      assert.equal((await page.request.get(old)).status(), 404);
      return { oldWorkingCopyRemoved: true, musicAndGainsPreserved: true };
    },
  );
  await check(
    'Mobile editor has no horizontal overflow and all controls remain reachable',
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(120);
      const sizing = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      assert.ok(sizing.scroll <= sizing.width, JSON.stringify(sizing));
      await page.screenshot({ path: `${screens}/mobile-edited.png`, fullPage: true });
      await page.locator('#export').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#export').isEnabled(), true);
      await page.setViewportSize({ width: 1440, height: 960 });
      return sizing;
    },
  );
  await check(
    'Music removal releases its working copy and leaves original audio available',
    async () => {
      const old = (await media()).music.src;
      await page.locator('#remove-music').click();
      assert.equal(await page.locator('#music-settings').isVisible(), false);
      assert.equal(await page.locator('#add-music').isEnabled(), true);
      assert.equal(await page.locator('#video-volume').isEnabled(), true);
      await page.waitForTimeout(100);
      assert.equal((await page.request.get(old)).status(), 404);
      return { oldWorkingCopyRemoved: true };
    },
  );
  await check('A running export can be cancelled through the UI and retried', async () => {
    const long = join(qa.dir, 'cancel-preview.mp4');
    await native(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=20',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '24',
      '-pix_fmt',
      'yuv420p',
      long,
    ]);
    await page.locator('#video-file-input').setInputFiles(long);
    await ready();
    await page.locator('#quality').selectOption('high');
    await page.locator('#export').click();
    await page.waitForFunction(
      () => !(document.getElementById('cancel-export') as HTMLButtonElement).disabled,
    );
    assert.equal(await page.locator('#trim-start').isDisabled(), true);
    await page.locator('#cancel-export').click();
    await page.waitForFunction(
      () => document.getElementById('job-title')?.textContent === 'Export cancelled',
    );
    assert.equal(await page.locator('#export').isEnabled(), true);
    assert.equal(await page.locator('#download').isVisible(), false);
    await fill('trim-end', '0.500');
    await page.locator('#export').click();
    await page.locator('#download').waitFor({ state: 'visible', timeout: 60000 });
    return { cancelled: true, retryComplete: true };
  });
  await check(
    'The minimum selection from a keyboard handle exports without floating-point rejection',
    async () => {
      await fill('trim-start', '0');
      await fill('trim-end', '6');
      await page.locator('#in-handle').press('End');
      const request = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().endsWith('/api/exports'),
      );
      await page.locator('#export').click();
      const payload = (await request).postDataJSON();
      assert.ok(Math.abs(payload.end - payload.start - 0.05) < 1e-9);
      await page.locator('#download').waitFor({ state: 'visible', timeout: 15000 });
      return { start: payload.start, end: payload.end, duration: payload.end - payload.start };
    },
  );
  assert.deepEqual(errors, []);
} catch (cause) {
  fatal = String(cause);
  console.error(cause);
} finally {
  const report = {
    created: new Date().toISOString(),
    browser: await browser.version(),
    isolated: true,
    url: qa.url,
    method:
      'Normal file inputs, pointer/keyboard/controls; read-only DOM/media observations; downloaded output independently probed by ffprobe.',
    results,
    errors,
    consoleErrors,
    fatal,
  };
  await writeFile('fixtures/editor-browser-results.json', JSON.stringify(report, null, 2));
  await browser.close();
  await qa.close();
}
if (fatal || results.some((r) => !r.pass) || errors.length) process.exitCode = 1;
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    fatal,
    errors,
  }),
);
