import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createContext,
  clip,
  project,
  overlay,
  track,
  exported,
  rgb,
  rgbFrame,
  timestamps,
  pcm,
  pixel,
  color,
  tone,
  rms,
  near,
  submit,
  json,
  native,
  ffmpeg,
  upload,
  type Context,
} from './native-helper';
let ctx: Context;
const results: { name: string; passed: boolean; durationMs: number; error?: string }[] = [];
before(
  async () => {
    ctx = await createContext();
  },
  { timeout: 90000 },
);
after(async () => {
  if (ctx) {
    await writeFile(
      new URL('./native-results.json', import.meta.url),
      JSON.stringify(
        {
          scope:
            'Independent generated-media native timeline exports; decoded frames and PCM over real local HTTP endpoints',
          createdAt: new Date().toISOString(),
          results,
          metrics: ctx.metrics,
        },
        null,
        2,
      ),
    );
    await ctx.close();
  }
});
const check = (name: string, run: () => Promise<void>) =>
  test(name, { timeout: 90000 }, async () => {
    const time = performance.now();
    try {
      await run();
      results.push({ name, passed: true, durationMs: performance.now() - time });
    } catch (error) {
      results.push({
        name,
        passed: false,
        durationMs: performance.now() - time,
        error: String(error),
      });
      throw error;
    }
  });
const asset = (name: string) => ctx.assets[name];
check(
  'cut/reordered mixed-size, mixed-FPS clips produce the declared CFR canvas and exact sequence',
  async () => {
    const p = project([
      clip(asset('color-tone.mp4'), { in: 1, out: 2 }),
      clip(asset('green-24.mp4'), { in: 0.5, out: 1.5 }),
      clip(asset('color-tone.mp4'), { in: 0, out: 0.5 }),
    ]);
    const output = await exported(ctx, p),
      data = await rgb(output.path),
      v = output.info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.width, 320);
    assert.equal(v.height, 180);
    assert.equal(v.avg_frame_rate, '30/1');
    assert.equal(Number(v.nb_read_frames), 75);
    near(Number(output.info.format.duration), 2.5, 0.025, 'sequence duration');
    color(pixel(data, 0.5, 160, 90), [0, 0, 255], 'first source cut is blue');
    color(pixel(data, 1.5, 160, 90), [0, 255, 0], 'reordered middle is green');
    color(pixel(data, 2.2, 160, 90), [255, 0, 0], 'final source cut is red');
    color(
      pixel(data, 1.5, 10, 90),
      [0, 0, 0],
      '4:3 contained source has transparent-to-black pillarbox',
    );
    color(pixel(data, 1, 160, 90), [0, 255, 0], 'first frame at cut belongs to next clip');
    color(pixel(data, 2, 160, 90), [255, 0, 0], 'second cut boundary');
    ctx.metrics.sequence = {
      duration: Number(output.info.format.duration),
      frames: Number(v.nb_read_frames),
      dimensions: [v.width, v.height],
      fps: v.avg_frame_rate,
    };
  },
);
check(
  'clip speed preserves pitch while video and audio change at the same source event',
  async () => {
    const measurements = [];
    for (const speed of [0.5, 1.5, 2]) {
      const duration = 1.5 / speed,
        event = 0.75 / speed,
        p = project([clip(asset('color-tone.mp4'), { in: 0.25, out: 1.75, speed })]),
        output = await exported(ctx, p),
        data = await rgb(output.path),
        audio = await pcm(output.path);
      near(Number(output.info.format.duration), duration, 0.04, `speed${speed}duration`);
      const before = event * 0.5,
        after = event + (duration - event) * 0.5;
      color(pixel(data, before, 160, 90), [255, 0, 0], `speed${speed}before source event`);
      color(pixel(data, after, 160, 90), [0, 0, 255], `speed${speed}after source event`);
      assert.ok(tone(audio, before, 440) > 0.07);
      assert.ok(tone(audio, before, 660) < 0.008);
      assert.ok(tone(audio, after, 660) > 0.07);
      assert.ok(tone(audio, after, 440) < 0.008);
      measurements.push({
        speed,
        duration: Number(output.info.format.duration),
        before440: tone(audio, before, 440),
        after660: tone(audio, after, 660),
      });
    }
    ctx.metrics.speed = measurements;
  },
);
check(
  'all supported frame rates preserve exact frame counts, cut positions and timestamps',
  async () => {
    const measurements = [];
    // Independent nearest-frame arithmetic for .31,.23,.37,.19,.41 seconds.
    const cases = [
      { fps: 24, counts: [7, 6, 9, 5, 10] },
      { fps: 25, counts: [8, 6, 9, 5, 10] },
      { fps: 30, counts: [9, 7, 11, 6, 12] },
      { fps: 50, counts: [16, 12, 19, 10, 21] },
      { fps: 60, counts: [19, 14, 22, 11, 25] },
    ] as const;
    for (const { fps, counts } of cases) {
      const p = project(
        [
          clip(asset('color-tone.mp4'), { out: 0.31 }),
          clip(asset('green-24.mp4'), { out: 0.23 }),
          clip(asset('color-tone.mp4'), { in: 1.1, out: 1.47 }),
          clip(asset('green-24.mp4'), { in: 0.3, out: 0.49 }),
          clip(asset('color-tone.mp4'), { in: 0.4, out: 0.81 }),
        ],
        { fps },
      );
      const colors = [
          [255, 0, 0],
          [0, 255, 0],
          [0, 0, 255],
          [0, 255, 0],
          [255, 0, 0],
        ],
        expectedFrames = counts.reduce<number>((sum, value) => sum + value, 0),
        output = await exported(ctx, p),
        data = await rgb(output.path),
        pts = await timestamps(output.path),
        v = output.info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      assert.equal(Number(v.nb_read_frames), expectedFrames);
      assert.equal(v.avg_frame_rate, `${fps}/1`);
      assert.equal(data.length, expectedFrames * 320 * 180 * 3);
      assert.equal(pts.length, expectedFrames);
      let frame = 0;
      for (let segment = 0; segment < counts.length; segment++)
        for (let n = 0; n < counts[segment]; n++, frame++) {
          color(
            pixel(data, frame / fps, 160, 90, 320, 180, fps),
            colors[segment],
            `${fps}FPS frame${frame}, segment${segment}`,
          );
          near(pts[frame], frame / fps, 0.000001, `${fps}FPS presentation timestamp${frame}`);
        }
      near(
        Number(output.info.format.duration),
        expectedFrames / fps,
        0.002,
        'frame-quantized duration',
      );
      measurements.push({
        fps,
        counts,
        totalFrames: expectedFrames,
        duration: Number(output.info.format.duration),
        maxTimestampError: Math.max(...pts.map((t, i) => Math.abs(t - i / fps))),
      });
    }
    ctx.metrics.quantizedJoins = measurements;
  },
);
check(
  'delayed original audio remains synchronized through clip trim/speed and video-overlay placement',
  async () => {
    const path = join(ctx.dir, 'delayed-timeline-audio.mp4');
    await native(ffmpeg, [
      '-v',
      'error',
      '-i',
      ctx.files['color-tone.mp4'],
      '-itsoffset',
      '1',
      '-i',
      ctx.files['color-tone.mp4'],
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-t',
      '2',
      path,
    ]);
    const delayed = await upload(ctx, path, 'video');
    const base = await exported(ctx, project([clip(delayed, { in: 0.4, out: 1.9, speed: 1.5 })])),
      basePcm = await pcm(base.path);
    assert.ok(rms(basePcm, 0.1, 0.3) < 0.0005, 'source delay scales with trimmed clip speed');
    near(
      tone(basePcm, 0.7, 440),
      0.1,
      0.012,
      'delayed source audio retains pitch after speed change',
    );
    const layer = await exported(
        ctx,
        project([clip(asset('silent.mp4'), { out: 2.2 })], {
          overlays: [overlay(delayed, { start: 0.2, duration: 1.5, in: 0.4, volume: 0.5 })],
        }),
      ),
      layerPcm = await pcm(layer.path);
    assert.ok(
      rms(layerPcm, 0.3, 0.6) < 0.0005,
      'overlay source delay is not zeroed when placed later',
    );
    near(tone(layerPcm, 1.2, 440), 0.05, 0.008, 'delayed video overlay sound placement');
    assert.ok(rms(layerPcm, 1.9, 2.1) < 0.0005);
    ctx.metrics.delayedTimelineAudio = {
      trimSpeedInitialRMS: rms(basePcm, 0.1, 0.3),
      trimSpeed440: tone(basePcm, 0.7, 440),
      overlayInitialRMS: rms(layerPcm, 0.3, 0.6),
      overlay440: tone(layerPcm, 1.2, 440),
    };
  },
);
check(
  'PNG alpha, box placement, opacity, transparent contain padding, timing and fades survive encoding',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 3 })], {
        overlays: [
          overlay(asset('transparency.png'), {
            start: 0.5,
            duration: 2,
            opacity: 0.5,
            fadeIn: 0.5,
            fadeOut: 0.5,
          }),
        ],
      }),
      output = await exported(ctx, p),
      data = await rgb(output.path);
    color(pixel(data, 0.3, 100, 70), [0, 0, 0], 'before overlay');
    color(pixel(data, 1.2, 100, 70), [64, 64, 64], 'half source alpha times half opacity', 8);
    color(pixel(data, 1.2, 220, 70), [0, 0, 0], 'fully transparent source half', 5);
    color(pixel(data, 1.2, 100, 46), [0, 0, 0], 'contain padding transparent', 5);
    color(pixel(data, 1.2, 60, 70), [0, 0, 0], 'outside normalized box', 5);
    color(pixel(data, 0.7, 100, 70), [26, 26, 26], 'fade-in alpha', 8);
    color(pixel(data, 2.3, 100, 70), [26, 26, 26], 'fade-out alpha', 8);
    color(pixel(data, 2.6, 100, 70), [0, 0, 0], 'after overlay', 5);
    ctx.metrics.alpha = {
      full: pixel(data, 1.2, 100, 70),
      fadeIn: pixel(data, 0.7, 100, 70),
      fadeOut: pixel(data, 2.3, 100, 70),
      transparent: pixel(data, 1.2, 220, 70),
      pixelTolerance: 8,
    };
  },
);
check(
  'video overlay uses its source in-point and places both picture and original audio on the timeline',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 3 })], {
        overlays: [
          overlay(asset('overlay.mp4'), { start: 0.5, duration: 1.25, in: 0.5, volume: 0.5 }),
        ],
      }),
      output = await exported(ctx, p),
      data = await rgb(output.path),
      audio = await pcm(output.path);
    color(pixel(data, 0.3, 120, 90), [0, 0, 0], 'video overlay before start');
    color(pixel(data, 0.75, 120, 90), [255, 255, 0], 'source before1second is yellow');
    color(pixel(data, 1.25, 120, 90), [255, 0, 255], 'source after1second is magenta');
    color(pixel(data, 2, 120, 90), [0, 0, 0], 'video overlay after end');
    near(tone(audio, 0.75, 880), 0.05, 0.008, 'overlay audio before source event');
    near(tone(audio, 1.25, 1320), 0.05, 0.008, 'overlay audio after source event');
    assert.ok(rms(audio, 0.1, 0.3) < 0.0005);
    assert.ok(rms(audio, 2, 2.7) < 0.0005);
    ctx.metrics.videoOverlay = {
      yellow880Hz: tone(audio, 0.75, 880),
      magenta1320Hz: tone(audio, 1.25, 1320),
      tailRMS: rms(audio, 2, 2.7),
    };
  },
);
check(
  'layers clip to the main timeline end and an invisible video overlay can still supply audio',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 1 })], {
        overlays: [
          overlay(asset('transparency.png'), { start: 0.75, duration: 2 }),
          overlay(asset('overlay.mp4'), { start: 0.2, duration: 2, opacity: 0, volume: 0.5 }),
        ],
        audio: [
          track(asset('music-660.wav'), { start: 0.5, duration: 3, volume: 0.25, loop: true }),
        ],
      }),
      output = await exported(ctx, p),
      data = await rgb(output.path),
      audio = await pcm(output.path),
      v = output.info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    near(Number(output.info.format.duration), 1, 0.025, 'layers cannot lengthen main timeline');
    assert.equal(Number(v.nb_read_frames), 30);
    color(pixel(data, 0.5, 100, 70), [0, 0, 0], 'invisible video does not cover base');
    color(pixel(data, 0.9, 100, 70), [128, 128, 128], 'image continues to main timeline end', 8);
    near(tone(audio, 0.8, 880), 0.05, 0.008, 'invisible video retains its audio volume');
    near(tone(audio, 0.8, 660), 0.025, 0.006, 'audio track clipped at timeline end');
    ctx.metrics.timelineEnd = {
      frames: 30,
      duration: Number(output.info.format.duration),
      invisibleOverlay880: tone(audio, 0.8, 880),
    };
  },
);
check(
  'multiple audio tracks honor absolute placement, source offset, whole-track loops, gains and fades',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 5 })], {
        audio: [
          track(asset('music-880.wav'), {
            start: 0.5,
            in: 2.5,
            duration: 3.5,
            volume: 0.5,
            loop: true,
            fadeIn: 0.4,
            fadeOut: 0.4,
          }),
          track(asset('music-660.wav'), {
            start: 1.5,
            in: 1.4,
            duration: 1.4,
            volume: 0.25,
            fadeIn: 0.2,
            fadeOut: 0.2,
          }),
        ],
      }),
      output = await exported(ctx, p),
      audio = await pcm(output.path);
    assert.ok(rms(audio, 0.1, 0.3) < 0.0005);
    near(tone(audio, 0.7, 880), 0.05, 0.008, 'first track fade-in starts at timeline.5');
    near(tone(audio, 1.2, 880), 0.025, 0.006, 'offset wraps to whole-track beginning');
    near(tone(audio, 2.2, 880), 0.05, 0.007, 'loop reaches source second interval');
    near(tone(audio, 3.7, 880), 0.075, 0.01, 'end fade relative to timeline track');
    near(tone(audio, 1.6, 660), 0.0125, 0.004, 'second track fade-in');
    near(tone(audio, 2.2, 660), 0.025, 0.005, 'second track own volume');
    near(tone(audio, 2.8, 660), 0.0125, 0.004, 'second track fade-out');
    assert.ok(tone(audio, 3.2, 660) < 0.0005);
    assert.ok(rms(audio, 4.2, 4.8) < 0.0005);
    ctx.metrics.multiAudio = {
      firstLoop880: tone(audio, 1.2, 880),
      secondTrack660: tone(audio, 2.2, 660),
      silentTailRMS: rms(audio, 4.2, 4.8),
    };
  },
);
check(
  'a music fade beyond the main timeline stays at its authored time rather than moving earlier',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 4 })], {
        audio: [track(asset('music-660.wav'), { duration: 10, volume: 1, loop: true, fadeOut: 2 })],
      }),
      output = await exported(ctx, p),
      audio = await pcm(output.path);
    near(Number(output.info.format.duration), 4, 0.002, 'truncated main duration');
    for (const t of [0.5, 2.5, 3.5, 3.8])
      near(
        tone(audio, t, 660),
        0.1,
        0.008,
        `authored fade starts at8seconds, level must remain unchanged at${t}`,
      );
    ctx.metrics.authoredFade = {
      mainDuration: 4,
      layerDuration: 10,
      authoredFadeStart: 8,
      lastMeasured660: tone(audio, 3.8, 660),
    };
  },
);
check(
  'a non-looping short source preserves a fade-in longer than its remaining audio',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 4 })], {
        audio: [
          track(asset('music-660.wav'), { in: 1, duration: 10, volume: 1, loop: false, fadeIn: 6 }),
        ],
      }),
      output = await exported(ctx, p),
      audio = await pcm(output.path);
    near(tone(audio, 0.6, 660), 0.01, 0.003, 'six-second authored fade at0.6seconds');
    near(tone(audio, 1.5, 660), 0.025, 0.004, 'six-second authored fade at1.5seconds');
    assert.ok(rms(audio, 2.3, 3.7) < 0.0005, 'nonloop source ends after its remaining two seconds');
    ctx.metrics.longFadeShortSource = {
      sourceRemaining: 2,
      authoredFadeIn: 6,
      atPoint6: tone(audio, 0.6, 660),
      at1Point5: tone(audio, 1.5, 660),
      silentTailRMS: rms(audio, 2.3, 3.7),
    };
  },
);
check(
  'the accepted one-frame video-overlay tail repeats the source final frame without flashing off',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 1.6 })], {
        overlays: [overlay(asset('overlay.mp4'), { start: 0.2, in: 1, duration: 1 + 1 / 30 })],
      }),
      output = await exported(ctx, p),
      data = await rgb(output.path);
    color(
      pixel(data, 1.2, 120, 90),
      [255, 0, 255],
      'accepted last frame retains magenta source picture',
    );
    color(
      pixel(data, 37 / 30, 120, 90),
      [0, 0, 0],
      'first frame after authored overlay end is uncovered',
    );
    ctx.metrics.overlayTail = {
      lastAccepted: pixel(data, 1.2, 120, 90),
      firstAfterEnd: pixel(data, 37 / 30, 120, 90),
    };
  },
);
check(
  'an oversized visible layer stack is rejected before rendering while invisible and out-of-time layers are ignored',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 0.1 })], {
      width: 3840,
      height: 2160,
      overlays: [overlay(asset('transparency.png'), { duration: 0.1, width: 2, height: 2 })],
    });
    // 2*3840*2160 base pixels + (7680*4320 output rectangle +32*16 source)=49,766,912.
    const rejected = await submit(ctx, p);
    assert.equal(rejected.status, 400);
    assert.match((await json(rejected)).error, /layer|heavy|resolution/i);
    const ignored = structuredClone(p);
    ignored.overlays[0].start = 1;
    ignored.overlays.push(
      overlay(asset('transparency.png'), { duration: 0.1, width: 2, height: 2, opacity: 0 }),
    );
    const accepted = await submit(ctx, ignored);
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const job = await json(accepted),
      cancelled = await fetch(`${ctx.url}/api/exports/${job.id}`, {
        method: 'DELETE',
        headers: { 'X-Editor-Token': ctx.token },
      });
    assert.equal(cancelled.status, 200);
    assert.equal((await json(cancelled)).status, 'cancelled');
    ctx.metrics.renderBudget = {
      estimatedPixels: 49766912,
      limitPixels: 48000000,
      rejectedBeforeRender: true,
      invisibleAndOutOfTimeIgnored: true,
    };
  },
);
check(
  'a silent base clip between audible clips preserves duration and produces a real audio gap',
  async () => {
    const p = project([
        clip(asset('color-tone.mp4'), { out: 1 }),
        clip(asset('silent.mp4'), { out: 1 }),
        clip(asset('green-24.mp4'), { out: 1 }),
      ]),
      output = await exported(ctx, p),
      audio = await pcm(output.path);
    near(Number(output.info.format.duration), 3, 0.025, 'silent-middle duration');
    assert.ok(tone(audio, 0.5, 440) > 0.07);
    assert.ok(rms(audio, 1.15, 1.85) < 0.0005);
    assert.ok(tone(audio, 2.5, 660) > 0.1);
    ctx.metrics.silentGap = { rms: rms(audio, 1.15, 1.85) };
  },
);
check(
  'projects and media IDs survive server restart; unresolved references block export',
  async () => {
    const p = project([clip(asset('color-tone.mp4'), { out: 1 })], {
        title: 'Persistence fixture',
      }),
      response = await fetch(`${ctx.url}/api/projects/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Editor-Token': ctx.token },
        body: JSON.stringify({ project: p }),
      });
    assert.ok([200, 201].includes(response.status), await response.clone().text());
    assert.deepEqual((await json(response)).project, p);
    const oldToken = ctx.token;
    await ctx.restart();
    assert.notEqual(ctx.token, oldToken);
    const loaded = await fetch(`${ctx.url}/api/projects/${p.id}`);
    assert.equal(loaded.status, 200);
    assert.deepEqual((await json(loaded)).project, p);
    const list = await json(await fetch(`${ctx.url}/api/media`));
    assert.ok(list.media.some((m: { id: string }) => m.id === p.clips[0].mediaId));
    const download = await fetch(new URL(asset('color-tone.mp4').url, ctx.url));
    assert.equal(download.status, 200);
    await exported(ctx, p);
    const missing = structuredClone(p);
    missing.clips[0].mediaId = randomUUID();
    const rejected = await submit(ctx, missing);
    assert.ok([400, 404, 422].includes(rejected.status), await rejected.text());
    ctx.metrics.persistence = {
      stableMediaIds: true,
      projectRoundTrip: true,
      newSessionToken: true,
      missingMediaBlocked: true,
    };
  },
);
check(
  'malformed project and export request bodies fail as client errors without damaging the server',
  async () => {
    let checked = 0;
    for (const [method, path] of [
      ['POST', '/api/exports'],
      ['PUT', `/api/projects/${randomUUID()}`],
    ])
      for (const body of ['null', '[]', '42', '"invalid"', '{']) {
        const response = await fetch(`${ctx.url}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Editor-Token': ctx.token },
          body,
        });
        assert.equal(
          response.status,
          400,
          `${method}${path} body${body}: ${await response.clone().text()}`,
        );
        assert.equal(typeof (await json(response)).error, 'string');
        checked++;
      }
    assert.equal((await fetch(`${ctx.url}/api/status`)).status, 200);
    ctx.metrics.malformedRequests = {
      checked,
      allClientErrors: true,
      serverRemainsAvailable: true,
    };
  },
);
check('cancellation stops a timeline composition and never serves its partial file', async () => {
  const p = project(
      Array.from({ length: 6 }, () => clip(asset('color-tone.mp4'))),
      { width: 1280, height: 720, fps: 60 },
    ),
    response = await submit(ctx, p);
  assert.equal(response.status, 202, await response.clone().text());
  const job = await json(response);
  const cancelled = await fetch(`${ctx.url}/api/exports/${job.id}`, {
    method: 'DELETE',
    headers: { 'X-Editor-Token': ctx.token },
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await json(cancelled)).status, 'cancelled');
  assert.equal((await fetch(`${ctx.url}/api/exports/${job.id}/file`)).status, 409);
  await exported(ctx, project([clip(asset('silent.mp4'), { out: 0.2 })]));
  ctx.metrics.cancellation = {
    cancelled: true,
    noPartialDownload: true,
    nextExportSucceeded: true,
  };
});
check(
  'a short 1080p60 composition with image and video layers completes as a practical export smoke test',
  async () => {
    const p = project([clip(asset('silent.mp4'), { out: 3 })], {
      width: 1920,
      height: 1080,
      fps: 60,
      overlays: [
        overlay(asset('transparency.png'), {
          start: 0.25,
          duration: 2.5,
          x: 0.05,
          y: 0.1,
          width: 0.3,
          height: 0.4,
          opacity: 0.5,
        }),
        overlay(asset('overlay.mp4'), {
          start: 0.5,
          duration: 2,
          x: 0.55,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          volume: 0.5,
        }),
      ],
    });
    const started = performance.now(),
      output = await exported(ctx, p),
      wallSeconds = (performance.now() - started) / 1000,
      v = output.info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    assert.equal(v.width, 1920);
    assert.equal(v.height, 1080);
    assert.equal(v.avg_frame_rate, '60/1');
    assert.equal(Number(v.nb_read_frames), 180);
    near(Number(output.info.format.duration), 3, 0.002, '1080p60 duration');
    const sample = await rgbFrame(output.path, 60);
    color(pixel(sample, 0, 200, 250, 1920, 1080, 60), [64, 64, 64], '1080p image alpha', 8);
    color(pixel(sample, 0, 1300, 700, 1920, 1080, 60), [255, 255, 0], '1080p video overlay');
    ctx.metrics.performanceSmoke = {
      width: 1920,
      height: 1080,
      fps: 60,
      duration: 3,
      frames: 180,
      wallSeconds,
      note: 'Single local smoke export of generated low-complexity footage; not a general performance benchmark',
    };
  },
);
