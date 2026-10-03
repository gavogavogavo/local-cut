/** Native integration QA. Generates disposable media and inspects decoded exports,
 * independently of the editor's filter-building implementation. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static') as string;
const ffprobe = (require('ffprobe-static') as { path: string }).path;
export async function native(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stderr.on('data', (b: Buffer) => errors.push(b));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            Error(`${binary} exited ${code}: ${Buffer.concat(errors).toString().slice(-4000)}`),
          ),
    );
  });
}
export interface EditorMedia {
  id: string;
  name: string;
  kind: string;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  url: string;
}
export interface QaContext {
  dir: string;
  url: string;
  token: string;
  video: EditorMedia;
  music: EditorMedia;
  silent: EditorMedia;
  videoPath: string;
  musicPath: string;
  sourceFrames: Buffer;
  sourceAudio: Float32Array;
  musicAudio: Float32Array;
  close(): Promise<void>;
  metrics: Record<string, unknown>;
}
const json = async (response: Response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
};
export async function upload(
  url: string,
  token: string,
  path: string,
  kind: 'video' | 'music',
): Promise<EditorMedia> {
  const response = await fetch(
    `${url}/api/media?kind=${kind}&name=${encodeURIComponent(path.split(/[\\/]/).at(-1)!)}`,
    {
      method: 'POST',
      headers: { 'X-Editor-Token': token, 'Content-Type': 'application/octet-stream' },
      body: await readFile(path),
    },
  );
  assert.equal(response.status, 201, JSON.stringify(await response.clone().text()));
  return json(response);
}
const pcm = async (path: string) => {
  const b = await native(ffmpeg, [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const frames = (path: string) =>
  native(ffmpeg, [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-an',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
const probe = async (path: string) =>
  JSON.parse(
    (
      await native(ffprobe, [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ])
    ).toString(),
  );
const tone = (data: Float32Array, at: number, hz: number, width = 0.1) => {
  let s = 0,
    c = 0;
  const first = Math.round((at - width / 2) * 48000),
    last = Math.round((at + width / 2) * 48000);
  for (let i = first; i < last; i++) {
    const a = (2 * Math.PI * hz * i) / 48000;
    s += data[i] * Math.sin(a);
    c += data[i] * Math.cos(a);
  }
  return (2 * Math.hypot(s, c)) / (last - first);
};
const rms = (data: Float32Array, start: number, end: number) => {
  let sum = 0;
  const a = Math.floor(start * 48000),
    b = Math.min(data.length, Math.floor(end * 48000));
  for (let i = a; i < b; i++) sum += data[i] ** 2;
  return Math.sqrt(sum / (b - a));
};
const near = (value: number, expected: number, tolerance: number, label: string) =>
  assert.ok(
    Math.abs(value - expected) <= tolerance,
    `${label}: ${value}, expected ${expected} ± ${tolerance}`,
  );
export async function createQaContext(): Promise<QaContext> {
  const dir = await mkdtemp(resolve('node_modules/.clip-editor-test-'));
  let server: { url: string; close(): Promise<void> } | undefined;
  try {
    const videoPath = join(dir, 'moving.mp4'),
      musicPath = join(dir, 'music.wav'),
      silentPath = join(dir, 'silent.mp4');
    await native(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      videoPath,
    ]);
    // Known piecewise amplitudes make music offset and whole-track looping observable.
    await native(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='sin(2*PI*880*t)*(if(lt(t,1),0.05,if(lt(t,2),0.1,0.2)))':s=48000:d=3",
      '-c:a',
      'pcm_s16le',
      musicPath,
    ]);
    await native(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      videoPath,
      '-an',
      '-c:v',
      'copy',
      silentPath,
    ]);
    const { startEditorServer } = await import('../server');
    server = await startEditorServer({
      port: 0,
      host: '127.0.0.1',
      storageDir: join(dir, 'storage'),
      legacyUi: true,
    });
    const status = await fetch(`${server.url}/api/status`);
    assert.equal(status.status, 200);
    const { token } = await json(status);
    assert.ok(typeof token === 'string' && token.length >= 24, 'unguessable session token');
    const video = await upload(server.url, token, videoPath, 'video'),
      music = await upload(server.url, token, musicPath, 'music'),
      silent = await upload(server.url, token, silentPath, 'video');
    const [sourceFrames, sourceAudio, musicAudio] = await Promise.all([
      frames(videoPath),
      pcm(videoPath),
      pcm(musicPath),
    ]);
    return {
      dir,
      url: server.url,
      token,
      video,
      music,
      silent,
      videoPath,
      musicPath,
      sourceFrames,
      sourceAudio,
      musicAudio,
      metrics: {},
      close: async () => {
        await server!.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
const settings = (ctx: QaContext, overrides: Record<string, unknown> = {}) => ({
  videoId: ctx.video.id,
  musicId: null,
  start: 1.2,
  end: 4.2,
  videoVolume: 1,
  musicVolume: 0.5,
  musicOffset: 0,
  fadeIn: 0,
  fadeOut: 0,
  loopMusic: false,
  quality: 'high',
  filename: 'qa-export',
  ...overrides,
});
const submit = (
  ctx: QaContext,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  fetch(`${ctx.url}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Editor-Token': ctx.token, ...headers },
    body: JSON.stringify(body),
  });
async function waitExport(ctx: QaContext, id: string) {
  const started = performance.now();
  let previous = 0;
  while (performance.now() - started < 60000) {
    const response = await fetch(`${ctx.url}/api/exports/${id}`);
    assert.equal(response.status, 200);
    const result = await json(response);
    if (typeof result.progress === 'number') {
      assert.ok(
        result.progress >= previous && result.progress >= 0 && result.progress <= 1,
        `monotonic progress: ${result.progress} after ${previous}`,
      );
      previous = result.progress;
    }
    if (result.status === 'complete') return result;
    if (result.status === 'error' || result.status === 'failed' || result.status === 'cancelled')
      throw Error(JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error('Native export did not finish within 60 seconds');
}
async function exportFile(ctx: QaContext, overrides: Record<string, unknown> = {}) {
  const response = await submit(ctx, settings(ctx, overrides));
  assert.equal(response.status, 202, await response.clone().text());
  const pending = await json(response),
    result = await waitExport(ctx, pending.id);
  assert.ok(typeof result.url === 'string');
  const download = await fetch(new URL(result.url, ctx.url));
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /video\/mp4/);
  const path = join(ctx.dir, `${pending.id}.mp4`);
  await writeFile(path, Buffer.from(await download.arrayBuffer()));
  return { path, result, probe: await probe(path) };
}
export const editorQaCases: { name: string; run(ctx: QaContext): Promise<void> }[] = [
  {
    name: 'uploads report measured video, music, and silent-track metadata',
    async run(c) {
      assert.equal(c.video.width, 320);
      assert.equal(c.video.height, 180);
      near(c.video.duration, 6, 0.025, 'source duration');
      near(c.video.fps!, 30, 0.001, 'source FPS');
      assert.equal(c.video.hasAudio, true);
      assert.equal(c.silent.hasAudio, false);
      near(c.music.duration, 3, 0.001, 'music duration');
    },
  },
  {
    name: 'trim exports the expected first and last frames, frame count, size, and duration',
    async run(c) {
      const output = await exportFile(c),
        v = output.probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      assert.equal(v.codec_name, 'h264');
      assert.equal(v.width, 320);
      assert.equal(v.height, 180);
      assert.equal(Number(v.nb_read_frames), 90);
      near(Number(output.probe.format.duration), 3, 0.025, 'trim duration');
      assert.equal(v.avg_frame_rate, '30/1');
      const decoded = await frames(output.path),
        size = 320 * 180;
      assert.equal(decoded.length, 90 * size);
      const compare = (outputIndex: number, sourceIndex: number) => {
        let sum = 0;
        for (let i = 0; i < size; i++)
          sum += Math.abs(decoded[outputIndex * size + i] - c.sourceFrames[sourceIndex * size + i]);
        return sum / size;
      };
      const first = compare(0, 36),
        last = compare(89, 125);
      assert.ok(
        first <= 4 && last <= 4,
        `decoded luma MAE first=${first}, last=${last}; predeclared limit 4/255`,
      );
      for (const delta of [-3, -2, -1, 1, 2, 3]) {
        assert.ok(
          first < compare(0, 36 + delta),
          `first frame should match input frame36 more closely than ${36 + delta}`,
        );
        assert.ok(
          last < compare(89, 125 + delta),
          `last frame should match input frame125 more closely than ${125 + delta}`,
        );
      }
      c.metrics.trim = {
        duration: Number(output.probe.format.duration),
        frames: 90,
        firstFrameLumaMAE: first,
        lastFrameLumaMAE: last,
        maxMAE: 4,
      };
    },
  },
  {
    name: 'original and music gains, offset, whole-track looping, and clip-relative fades are audible in decoded PCM',
    async run(c) {
      const output = await exportFile(c, {
          start: 0.5,
          end: 4.5,
          musicId: c.music.id,
          videoVolume: 0.4,
          musicVolume: 0.5,
          musicOffset: 1.5,
          fadeIn: 0.8,
          fadeOut: 0.8,
          loopMusic: true,
        }),
        data = await pcm(output.path);
      const measurements = [];
      for (const t of [0.2, 0.9, 1.8, 2.8, 3.8]) {
        const originalExpected = tone(c.sourceAudio, t + 0.5, 440) * 0.4;
        const musicExpected =
          tone(c.musicAudio, (1.5 + t) % 3, 880) * 0.5 * Math.min(1, t / 0.8, (4 - t) / 0.8);
        const original = tone(data, t, 440),
          music = tone(data, t, 880);
        near(original, originalExpected, 0.004 + originalExpected * 0.08, `440Hz gain at ${t}`);
        near(music, musicExpected, 0.003 + musicExpected * 0.1, `880Hz offset/loop/fade at ${t}`);
        measurements.push({ t, original, originalExpected, music, musicExpected });
      }
      c.metrics.mix = measurements;
    },
  },
  {
    name: 'non-looping music ends in silence and muted original audio remains absent',
    async run(c) {
      const output = await exportFile(c, {
          start: 0,
          end: 4,
          musicId: c.music.id,
          videoVolume: 0,
          musicVolume: 0.5,
          musicOffset: 1.5,
          loopMusic: false,
        }),
        data = await pcm(output.path);
      near(tone(data, 0.25, 880), 0.05, 0.007, 'nonloop offset starts in second music section');
      near(tone(data, 1, 880), 0.1, 0.012, 'nonloop reaches final music section');
      assert.ok(rms(data, 2, 3.5) < 0.0005, 'music must not repeat after remaining1.5seconds');
      assert.ok(tone(data, 0.7, 440) < 0.0005, 'muted original440Hz must be absent');
      near(Number(output.probe.format.duration), 4, 0.025, 'silence tail retains clip length');
      c.metrics.nonloop = { tailRMS: rms(data, 2, 3.5), original440Hz: tone(data, 0.7, 440) };
    },
  },
  {
    name: 'short non-looping music fades at its audible end before the silent clip tail',
    async run(c) {
      const output = await exportFile(c, {
          start: 0,
          end: 4,
          musicId: c.music.id,
          videoVolume: 0,
          musicVolume: 0.5,
          musicOffset: 1.5,
          loopMusic: false,
          fadeIn: 0.2,
          fadeOut: 0.5,
        }),
        data = await pcm(output.path);
      near(tone(data, 0.1, 880), 0.025, 0.006, 'short music fade-in');
      near(tone(data, 1.25, 880), 0.05, 0.007, 'short music fade-out ends at1.5seconds');
      assert.ok(rms(data, 2, 3.5) < 0.0005);
      c.metrics.shortMusicFade = {
        fadeIn880Hz: tone(data, 0.1, 880),
        fadeOut880Hz: tone(data, 1.25, 880),
        silentTailRMS: rms(data, 2, 3.5),
      };
    },
  },
  {
    name: 'silent video exports without invented audio; music-only exports work',
    async run(c) {
      const empty = await exportFile(c, { videoId: c.silent.id, start: 0, end: 2 });
      const audio = empty.probe.streams.filter(
        (s: { codec_type: string }) => s.codec_type === 'audio',
      );
      if (audio.length)
        assert.ok(
          rms(await pcm(empty.path), 0.2, 1.8) < 0.0001,
          'silent source must remain silent',
        );
      const music = await exportFile(c, {
          videoId: c.silent.id,
          musicId: c.music.id,
          start: 0,
          end: 2,
          musicVolume: 0.5,
        }),
        data = await pcm(music.path);
      near(tone(data, 1.5, 880), 0.05, 0.007, 'music-only level');
      assert.ok(tone(data, 1.5, 440) < 0.0005);
      assert.equal(
        music.probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
          .codec_name,
        'aac',
      );
    },
  },
  {
    name: 'an original audio track that starts late preserves its video synchronization',
    async run(c) {
      const delayedPath = join(c.dir, 'delayed-audio.mp4');
      await native(ffmpeg, [
        '-v',
        'error',
        '-i',
        c.videoPath,
        '-itsoffset',
        '1',
        '-i',
        c.videoPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-t',
        '6',
        delayedPath,
      ]);
      const source = await probe(delayedPath),
        audioStart = Number(
          source.streams.find((s: { codec_type: string }) => s.codec_type === 'audio').start_time,
        );
      assert.ok(
        audioStart > 0.95 && audioStart < 1.05,
        'fixture has independently measured audio timestamp delay',
      );
      const delayed = await upload(c.url, c.token, delayedPath, 'video'),
        measurements = [];
      for (const start of [0, 0.4, 1.2]) {
        const output = await exportFile(c, { videoId: delayed.id, start, end: start + 3 }),
          data = await pcm(output.path);
        if (start < 1) {
          const quiet = rms(data, 0.1, 0.8 - start);
          assert.ok(
            quiet < 0.0005,
            `intentional initial silence must remain after trim ${start}; measured RMS ${quiet}`,
          );
          measurements.push({ start, initialSilenceRMS: quiet });
        }
        near(
          tone(data, 1.5, 440),
          tone(c.sourceAudio, 0.5 + start, 440),
          0.012,
          `delayed original audio level after trim ${start}`,
        );
      }
      c.metrics.audioSync = { inputAudioStart: audioStart, measurements };
    },
  },
  {
    name: 'compact export pads odd dimensions and retains the first original audio track',
    async run(c) {
      const oddPath = join(c.dir, 'odd-with-two-audio-tracks.mp4');
      await native(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=321x181:rate=24:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000:duration=2',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv444p',
        '-c:a',
        'aac',
        '-shortest',
        oddPath,
      ]);
      const odd = await upload(c.url, c.token, oddPath, 'video'),
        output = await exportFile(c, { videoId: odd.id, start: 0, end: 2, quality: 'compact' }),
        video = output.probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video'),
        data = await pcm(output.path);
      assert.equal(video.width, 322);
      assert.equal(video.height, 182);
      assert.equal(video.avg_frame_rate, '24/1');
      assert.equal(Number(video.nb_read_frames), 48);
      assert.ok(tone(data, 1, 440) > 0.1);
      assert.ok(
        tone(data, 1, 660) < 0.001,
        'second original audio track must not replace or mix with the first',
      );
      c.metrics.oddDimensions = {
        source: [321, 181],
        output: [video.width, video.height],
        fps: 24,
        first440Hz: tone(data, 1, 440),
        second660Hz: tone(data, 1, 660),
      };
    },
  },
  {
    name: 'media byte ranges return exact bytes and malformed ranges fail safely',
    async run(c) {
      const original = await readFile(c.videoPath),
        url = new URL(c.video.url, c.url);
      const response = await fetch(url, { headers: { Range: 'bytes=17-88' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes 17-88/${original.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), original.subarray(17, 89));
      const suffix = await fetch(url, { headers: { Range: 'bytes=-64' } });
      assert.equal(suffix.status, 206);
      assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), original.subarray(-64));
      const invalid = await fetch(url, { headers: { Range: `bytes=${original.length + 2}-` } });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), `bytes */${original.length}`);
    },
  },
  {
    name: 'invalid and interrupted imports remove partial files and permit a clean retry',
    async run(c) {
      const imports = join(c.dir, 'storage', 'imports'),
        before = (await readdir(imports)).sort();
      const failed = await fetch(`${c.url}/api/media?kind=video&name=invalid.mp4`, {
        method: 'POST',
        headers: { 'X-Editor-Token': c.token },
        body: 'This is deliberately not a media file.',
      });
      assert.equal(failed.status, 400);
      assert.deepEqual(
        (await readdir(imports)).sort(),
        before,
        'failed probe must remove its uploaded copy',
      );
      const bytes = await readFile(c.videoPath),
        partial = request(`${c.url}/api/media?kind=video&name=interrupted.mp4`, {
          method: 'POST',
          headers: { 'X-Editor-Token': c.token, 'Content-Length': bytes.length + 1000 },
        });
      partial.on('error', () => {});
      partial.write(bytes.subarray(0, Math.min(bytes.length, 65536)));
      let observedPartial = false;
      for (let i = 0; i < 100; i++) {
        if ((await readdir(imports)).length > before.length) {
          observedPartial = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      partial.destroy();
      assert.equal(observedPartial, true, 'test must interrupt a real server-side partial upload');
      for (let i = 0; i < 100 && (await readdir(imports)).length !== before.length; i++)
        await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(
        (await readdir(imports)).sort(),
        before,
        'interrupted upload must remove its partial file',
      );
      const retry = await upload(c.url, c.token, c.videoPath, 'video');
      assert.equal(retry.hasAudio, true);
      const removed = await fetch(new URL(retry.url, c.url), {
        method: 'DELETE',
        headers: { 'X-Editor-Token': c.token },
      });
      assert.equal(removed.status, 200);
      assert.deepEqual((await readdir(imports)).sort(), before);
      c.metrics.importRecovery = {
        invalidRemoved: true,
        interruptedRemoved: true,
        retrySucceeded: true,
      };
    },
  },
  {
    name: 'invalid bounds, IDs, gains, fades, and qualities are rejected before export',
    async run(c) {
      for (const change of [
        { start: -1 },
        { end: 7 },
        { start: 3, end: 2 },
        { start: 1, end: 1.01 },
        { videoId: 'missing' },
        { videoId: c.music.id },
        { musicId: c.video.id },
        { musicId: 'missing' },
        { videoVolume: 2 },
        { musicVolume: -1 },
        { musicId: c.music.id, musicOffset: 3 },
        { fadeIn: -1 },
        { fadeOut: 4 },
        { quality: 'unrecognized' },
      ]) {
        const response = await submit(c, settings(c, change));
        assert.ok(
          [400, 404, 422].includes(response.status),
          `expected client error for ${JSON.stringify(change)}, got ${response.status}: ${await response.text()}`,
        );
      }
    },
  },
  {
    name: 'mutating requests require the token and untrusted web origins cannot control the local editor',
    async run(c) {
      const absent = await fetch(`${c.url}/api/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings(c)),
      });
      assert.ok([401, 403].includes(absent.status));
      const wrong = await submit(c, settings(c), { 'X-Editor-Token': 'wrong' });
      assert.ok([401, 403].includes(wrong.status));
      const foreign = await submit(c, settings(c), { Origin: 'https://untrusted.example' });
      assert.equal(foreign.status, 403);
      assert.notEqual(foreign.headers.get('access-control-allow-origin'), '*');
      const peek = await fetch(`${c.url}/api/status`, {
        headers: { Origin: 'https://untrusted.example' },
      });
      assert.equal(peek.status, 403);
    },
  },
  {
    name: 'cancelling a native export terminates the job without publishing a partial MP4',
    async run(c) {
      const response = await submit(c, settings(c, { start: 0, end: 6 }));
      assert.equal(response.status, 202);
      const job = await json(response);
      const cancelled = await fetch(`${c.url}/api/exports/${job.id}`, {
        method: 'DELETE',
        headers: { 'X-Editor-Token': c.token },
      });
      assert.ok([200, 202, 204].includes(cancelled.status), await cancelled.text());
      await new Promise((r) => setTimeout(r, 100));
      const stateResponse = await fetch(`${c.url}/api/exports/${job.id}`);
      assert.equal(stateResponse.status, 200);
      const state = await json(stateResponse);
      assert.equal(
        state.status,
        'cancelled',
        'cancellation must win before the native encode completes',
      );
      assert.ok(!state.url, 'cancelled jobs must not expose an output URL');
      assert.equal((await fetch(`${c.url}/api/exports/${job.id}/file`)).status, 409);
      await exportFile(c, { start: 0, end: 0.5 });
      c.metrics.cancellation = state.status;
    },
  },
];
export async function runEditorQa() {
  const context = await createQaContext(),
    results: unknown[] = [];
  try {
    for (const item of editorQaCases) {
      const started = performance.now();
      await item.run(context);
      results.push({ name: item.name, passed: true, durationMs: performance.now() - started });
      console.log(`PASS ${item.name}`);
    }
    const report = {
      scope:
        'Native local MP4 editor integration; generated media, decoded frames and PCM, real HTTP endpoints',
      createdAt: new Date().toISOString(),
      results,
      metrics: context.metrics,
    };
    await writeFile('fixtures/editor-native-validation.json', JSON.stringify(report, null, 2));
    return report;
  } finally {
    await context.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void runEditorQa().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
