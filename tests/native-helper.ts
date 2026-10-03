/** Generated, independently specified media for native composition tests.
 * All assets and server data are temporary. No game files are imported. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { startEditorServer } from '../server';
import type { Clip, Overlay, Audio, Project } from '../studio/model.js';
export type { Clip, Overlay, Audio, Project } from '../studio/model.js';
const require = createRequire(import.meta.url);
export const ffmpeg = require('ffmpeg-static') as string;
const ffprobe = (require('ffprobe-static') as { path: string }).path;
export async function native(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
      output: Buffer[] = [],
      errors: Buffer[] = [];
    const timeout = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve(Buffer.concat(output))
        : reject(
            Error(
              `Native media tool exited ${code}: ${Buffer.concat(errors).toString().slice(-5000)}`,
            ),
          );
    });
  });
}
export interface Asset {
  id: string;
  kind: 'video' | 'music' | 'image';
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  url: string;
  name: string;
}
export const clip = (asset: Asset, overrides: Partial<Clip> = {}): Clip => ({
  id: randomUUID(),
  mediaId: asset.id,
  in: 0,
  out: asset.duration,
  speed: 1,
  volume: 1,
  fit: 'contain',
  ...overrides,
});
export const overlay = (asset: Asset, overrides: Partial<Overlay> = {}): Overlay => ({
  id: randomUUID(),
  mediaId: asset.id,
  start: 0,
  duration: 1,
  in: 0,
  x: 0.25,
  y: 0.25,
  width: 0.5,
  height: 0.5,
  opacity: 1,
  volume: 0,
  fadeIn: 0,
  fadeOut: 0,
  ...overrides,
});
export const track = (asset: Asset, overrides: Partial<Audio> = {}): Audio => ({
  id: randomUUID(),
  mediaId: asset.id,
  start: 0,
  in: 0,
  duration: 1,
  volume: 1,
  loop: false,
  fadeIn: 0,
  fadeOut: 0,
  ...overrides,
});
export const project = (clips: Clip[], overrides: Partial<Project> = {}): Project => ({
  version: 2,
  id: randomUUID(),
  title: 'Generated native QA',
  width: 320,
  height: 180,
  fps: 30,
  clips,
  overlays: [],
  audio: [],
  ...overrides,
});
export interface Context {
  dir: string;
  storageDir: string;
  url: string;
  token: string;
  files: Record<string, string>;
  assets: Record<string, Asset>;
  metrics: Record<string, unknown>;
  restart(): Promise<void>;
  close(): Promise<void>;
}
export const json = async (response: Response) => {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw Error(`HTTP${response.status}: ${body.slice(0, 200)}`);
  }
};
export async function upload(
  ctx: Pick<Context, 'url' | 'token'>,
  path: string,
  kind: Asset['kind'],
): Promise<Asset> {
  const response = await fetch(
    `${ctx.url}/api/media?kind=${kind}&name=${encodeURIComponent(basename(path))}`,
    {
      method: 'POST',
      headers: { 'X-Editor-Token': ctx.token, 'Content-Type': 'application/octet-stream' },
      body: await readFile(path),
    },
  );
  assert.equal(response.status, 201, await response.clone().text());
  return json(response);
}
export async function createContext(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'clip-studio-native-')),
    storageDir = join(dir, 'storage'),
    files: Record<string, string> = {};
  let server: Awaited<ReturnType<typeof startEditorServer>> | undefined;
  const path = (name: string) => (files[name] = join(dir, name));
  const encode = (args: string[]) => native(ffmpeg, ['-v', 'error', '-nostdin', ...args]);
  try {
    // The base clip changes both color and audio frequency exactly at source t=1.
    await encode([
      '-f',
      'lavfi',
      '-i',
      "color=c=red:s=160x90:r=30:d=2,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,1)'",
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(t,1),0.1*sin(2*PI*440*t),0.1*sin(2*PI*660*t))':s=48000:d=2",
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'ultrafast',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      path('color-tone.mp4'),
    ]);
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=lime:s=192x144:r=24:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=48000:duration=3',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'ultrafast',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      path('green-24.mp4'),
    ]);
    await encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=30:d=5',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'ultrafast',
      '-crf',
      '10',
      '-an',
      path('silent.mp4'),
    ]);
    await encode([
      '-f',
      'lavfi',
      '-i',
      "color=c=yellow:s=96x54:r=30:d=2,drawbox=x=0:y=0:w=iw:h=ih:color=magenta:t=fill:enable='gte(t,1)'",
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(t,1),0.1*sin(2*PI*880*t),0.1*sin(2*PI*1320*t))':s=48000:d=2",
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'ultrafast',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      path('overlay.mp4'),
    ]);
    await encode([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='sin(2*PI*880*t)*(if(lt(t,1),0.05,if(lt(t,2),0.1,0.2)))':s=48000:d=3",
      '-c:a',
      'pcm_s16le',
      path('music-880.wav'),
    ]);
    await encode([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.1*sin(2*PI*660*t):s=48000:d=3',
      '-c:a',
      'pcm_s16le',
      path('music-660.wav'),
    ]);
    const rgba = Buffer.alloc(32 * 16 * 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
        rgba[i + 3] = x < 16 ? 128 : 0;
      }
    const rawPath = path('transparency.rgba');
    await writeFile(rawPath, rgba);
    await encode([
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgba',
      '-video_size',
      '32x16',
      '-i',
      rawPath,
      '-frames:v',
      '1',
      path('transparency.png'),
    ]);
    server = await startEditorServer({ port: 0, host: '127.0.0.1', storageDir });
    const ctx: Context = {
      dir,
      storageDir,
      url: server.url,
      token: (await json(await fetch(`${server.url}/api/status`))).token,
      files,
      assets: {},
      metrics: {},
      async restart() {
        await server!.close();
        server = await startEditorServer({ port: 0, host: '127.0.0.1', storageDir });
        ctx.url = server.url;
        ctx.token = (await json(await fetch(`${ctx.url}/api/status`))).token;
      },
      async close() {
        await server?.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
    for (const [name, kind] of [
      ['color-tone.mp4', 'video'],
      ['green-24.mp4', 'video'],
      ['silent.mp4', 'video'],
      ['overlay.mp4', 'video'],
      ['music-880.wav', 'music'],
      ['music-660.wav', 'music'],
      ['transparency.png', 'image'],
    ] as const)
      ctx.assets[name] = await upload(ctx, files[name], kind);
    return ctx;
  } catch (error) {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
export const submit = (ctx: Context, value: Project) =>
  fetch(`${ctx.url}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Editor-Token': ctx.token },
    body: JSON.stringify({ project: value, quality: 'high', filename: 'timeline-native-qa.mp4' }),
  });
export async function exported(ctx: Context, value: Project) {
  const response = await submit(ctx, value);
  assert.equal(response.status, 202, await response.clone().text());
  const pending = await json(response);
  const start = performance.now();
  let progress = 0;
  while (performance.now() - start < 60000) {
    const status = await fetch(`${ctx.url}/api/exports/${pending.id}`);
    assert.equal(status.status, 200);
    const result = await json(status);
    assert.ok(result.progress >= progress && result.progress <= 1);
    progress = result.progress;
    if (result.status === 'complete') {
      const download = await fetch(new URL(result.url, ctx.url));
      assert.equal(download.status, 200);
      const path = join(ctx.dir, `${pending.id}.mp4`);
      await writeFile(path, Buffer.from(await download.arrayBuffer()));
      return { path, result, info: await probe(path) };
    }
    if (result.status !== 'running') throw Error(JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Timeline export timed out');
}
export const probe = async (path: string) =>
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
export const rgb = (path: string) =>
  native(ffmpeg, [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-an',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
export const rgbFrame = (path: string, index: number) =>
  native(ffmpeg, [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    `select=eq(n\\,${index})`,
    '-frames:v',
    '1',
    '-an',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
export const timestamps = async (path: string): Promise<number[]> =>
  JSON.parse(
    (
      await native(ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        path,
      ])
    ).toString(),
  ).frames.map((frame: { best_effort_timestamp_time: string }) =>
    Number(frame.best_effort_timestamp_time),
  );
export async function pcm(path: string): Promise<Float32Array> {
  const bytes = await native(ffmpeg, [
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
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}
export const pixel = (
  data: Buffer,
  t: number,
  x: number,
  y: number,
  width = 320,
  height = 180,
  fps = 30,
) => {
  const i = (Math.round(t * fps) * width * height + y * width + x) * 3;
  return Array.from(data.subarray(i, i + 3));
};
export function color(actual: number[], expected: number[], label: string, tolerance = 12) {
  assert.equal(actual.length, 3);
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label} RGB=${actual}, expected ${expected}, per-channel tolerance${tolerance}`,
    );
}
export const tone = (data: Float32Array, t: number, hz: number, width = 0.1) => {
  let s = 0,
    c = 0;
  const first = Math.round((t - width / 2) * 48000),
    last = Math.round((t + width / 2) * 48000);
  for (let i = first; i < last; i++) {
    const angle = (2 * Math.PI * hz * i) / 48000;
    s += data[i] * Math.sin(angle);
    c += data[i] * Math.cos(angle);
  }
  return (2 * Math.hypot(s, c)) / (last - first);
};
export const rms = (data: Float32Array, start: number, end: number) => {
  let sum = 0;
  const first = Math.round(start * 48000),
    last = Math.min(data.length, Math.round(end * 48000));
  for (let i = first; i < last; i++) sum += data[i] ** 2;
  return Math.sqrt(sum / (last - first));
};
export const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, expected ${expected}±${tolerance}`,
  );
