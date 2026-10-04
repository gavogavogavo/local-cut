import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createProject,
  normalizeProject,
  validateProject,
  clipFrames,
  duration,
  timelineDuration,
  clipStarts,
  clipAt,
  splitClip,
  splitAudio,
  trimAudio,
  removeItem,
  duplicateItem,
  moveClip,
  appendClip,
  addOverlay,
  addAudio,
  ModelError,
  type Project,
  type Clip,
  type ModelMedia,
} from '../studio/model.js';

const video: ModelMedia = {
  id: randomUUID(),
  kind: 'video',
  duration: 20,
  width: 3840,
  height: 2160,
  fps: 120,
  hasAudio: true,
};
const silent: ModelMedia = { ...video, id: randomUUID(), hasAudio: false };
const image: ModelMedia = { id: randomUUID(), kind: 'image', duration: 0, width: 100, height: 80 };
const music: ModelMedia = { id: randomUUID(), kind: 'music', duration: 4, hasAudio: true };
const library = new Map([video, silent, image, music].map((m) => [m.id, m]));
const clip = (source: ModelMedia, from = 0, to = source.duration, speed = 1): Clip => ({
  id: randomUUID(),
  mediaId: source.id,
  in: from,
  out: to,
  speed,
  volume: 1,
  fit: 'contain',
});
const project = (clips: Clip[], fps: Project['fps'] = 30): Project =>
  normalizeProject({ ...createProject({ fps }), clips });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const part of Object.values(value)) freeze(part);
  }
  return value;
}

test('project defaults are explicit, independent and JSON round-trip stable', () => {
  const a = createProject(),
    b = createProject();
  assert.equal(a.version, 2);
  assert.equal(a.width, 1920);
  assert.equal(a.height, 1080);
  assert.equal(a.fps, 60);
  assert.notEqual(a.id, b.id);
  assert.equal(duration(a), 0);
  assert.deepEqual(clipStarts(a), []);
  assert.equal(clipAt(a, 0), null);
  assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(a))), a);
});

test('appending a source preserves the explicitly configured canvas and frame rate', () => {
  const original = freeze(createProject({ width: 1080, height: 1920, fps: 25 })),
    next = appendClip(original, video);
  assert.equal(next.width, 1080);
  assert.equal(next.height, 1920);
  assert.equal(next.fps, 25);
  assert.equal(original.clips.length, 0);
  assert.equal(next.clips.length, 1);
  assert.equal(duration(next), 20);
});

test('main timing sums independently rounded integer frame counts', () => {
  const p = project([clip(video, 0, 0.051), clip(video, 1, 1.051), clip(video, 2, 2.051)], 30);
  assert.deepEqual(
    p.clips.map((c) => clipFrames(p, c)),
    [2, 2, 2],
  );
  assert.equal(duration(p), 6 / 30);
  assert.deepEqual(clipStarts(p), [0, 2 / 30, 4 / 30]);
  assert.notEqual(
    duration(p),
    0.051 * 3,
    'raw source fractions must not accumulate timeline drift',
  );
});

test('clipAt uses half-open sequential ranges and speed-adjusted source time', () => {
  const p = project([clip(video, 10, 16, 2), clip(video, 2, 4, 0.5)], 30);
  assert.deepEqual(clipStarts(p), [0, 3]);
  assert.equal(duration(p), 7);
  assert.equal(clipAt(p, 1.25)?.sourceTime, 12.5);
  assert.equal(clipAt(p, 3)?.clip.id, p.clips[1].id);
  assert.equal(clipAt(p, 3)?.sourceTime, 2);
  assert.equal(clipAt(p, 5)?.sourceTime, 3);
  assert.equal(clipAt(p, 7), null);
  for (const time of [-1, NaN, Infinity]) assert.equal(clipAt(p, time), null);
  const rounded = project([clip(video, 0, 0.051)], 30);
  assert.equal(
    clipAt(rounded, 0.06)?.sourceTime,
    0.051,
    'the padded last frame cannot seek beyond the source cut',
  );
});

test('split snaps an absolute cut to an output frame and maps through source speed', () => {
  const p = freeze(project([clip(video, 0, 2), clip(video, 3, 11, 2)])),
    before = JSON.stringify(p),
    id = p.clips[1].id;
  const result = splitClip(p, id, 3.51);
  assert.equal(result.clips.length, 3);
  assert.equal(result.clips[1].id, id);
  assert.notEqual(result.clips[2].id, id);
  assert.equal(result.clips[1].in, 3);
  assert.equal(result.clips[1].out, 6);
  assert.equal(result.clips[2].in, 6);
  assert.equal(result.clips[2].out, 11);
  assert.deepEqual(
    result.clips.map((c) => clipFrames(result, c)),
    [60, 45, 75],
  );
  assert.equal(duration(result), duration(p));
  assert.equal(JSON.stringify(p), before);
});

test('split requires a real output frame of source material on both sides', () => {
  const p = project([clip(video, 0, 0.1)]),
    id = p.clips[0].id;
  assert.throws(() => splitClip(p, id, 0), ModelError);
  assert.throws(() => splitClip(p, id, 0.1), ModelError);
  assert.throws(() => splitClip(p, id, Infinity), ModelError);
  assert.throws(() => splitClip(p, randomUUID(), 0.05), ModelError);
  assert.deepEqual(
    splitClip(p, id, 1 / 30).clips.map((c) => clipFrames(p, c)),
    [1, 2],
  );
  const short = project([clip(video, 0, 2.6 / 30)]);
  assert.throws(() => splitClip(short, short.clips[0].id, 2 / 30), /source frame/);
});

test('split preserves exact output frame totals across supported rates and speeds', () => {
  for (const fps of [24, 25, 30, 50, 60] as const)
    for (const speed of [0.25, 0.5, 1, 1.5, 2, 4]) {
      const p = project([clip(video, 3, 3 + (17.25 / fps) * speed, speed)], fps);
      const result = splitClip(p, p.clips[0].id, 7 / fps);
      assert.deepEqual(
        result.clips.map((c) => clipFrames(result, c)),
        [7, 10],
        `${fps}fps at ${speed}x`,
      );
      assert.equal(duration(result), duration(p));
      assert.equal(result.clips[0].out, result.clips[1].in);
      assert.equal(result.clips[1].out, p.clips[0].out);
    }
});

test('ripple removal and reordering never shift, trim or delete absolute layers', () => {
  let p = project([clip(video, 0, 3), clip(video, 3, 8), clip(video, 8, 10)]);
  p = addOverlay(p, image, 9);
  p = addAudio(p, music, 8);
  const layerSnapshot = JSON.stringify({ overlays: p.overlays, audio: p.audio });
  freeze(p);
  const removed = removeItem(p, 'clip', p.clips[1].id);
  assert.equal(duration(removed), 5);
  assert.equal(removed.overlays[0].start, 9);
  assert.equal(JSON.stringify({ overlays: removed.overlays, audio: removed.audio }), layerSnapshot);
  const moved = moveClip(p, p.clips[2].id, 0);
  assert.deepEqual(
    moved.clips.map((c) => c.id),
    [p.clips[2].id, p.clips[0].id, p.clips[1].id],
  );
  assert.deepEqual(clipStarts(moved), [0, 2, 5]);
  assert.equal(duration(moved), 10);
  assert.equal(JSON.stringify({ overlays: moved.overlays, audio: moved.audio }), layerSnapshot);
});

test('duplicate creates a new ID while preserving source, speed and layer time', () => {
  let p = project([clip(video, 4, 10, 2)]);
  p = addOverlay(p, image, 2);
  p = addAudio(p, music, 1);
  freeze(p);
  const main = duplicateItem(p, 'clip', p.clips[0].id);
  assert.equal(duration(main), 6);
  assert.notEqual(main.clips[0].id, main.clips[1].id);
  assert.deepEqual({ ...main.clips[1], id: main.clips[0].id }, main.clips[0]);
  for (const kind of ['overlay', 'audio'] as const) {
    const key = kind === 'overlay' ? 'overlays' : 'audio',
      copy = duplicateItem(p, kind, p[key][0].id);
    assert.equal(copy[key][1].start, p[key][0].start);
    assert.notEqual(copy[key][1].id, p[key][0].id);
    assert.equal(p[key].length, 1);
  }
});

test('move accepts an end insertion index and rejects invalid positions', () => {
  const p = project([clip(video, 0, 1), clip(video, 1, 3), clip(video, 3, 6)]);
  assert.deepEqual(
    moveClip(p, p.clips[0].id, 3).clips.map((c) => c.id),
    [p.clips[1].id, p.clips[2].id, p.clips[0].id],
  );
  for (const n of [-1, 1.2, 4, NaN]) assert.throws(() => moveClip(p, p.clips[0].id, n), ModelError);
  assert.throws(() => moveClip(p, randomUUID(), 0), ModelError);
});

test('normalization allows unresolved IDs for project saving but export requires relinking', () => {
  const p = project([clip(video, 0, 1)]);
  assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(p))), p);
  assert.throws(() => validateProject(p, new Map()), /Relink/);
  const missing = normalizeProject({ ...p, clips: [{ ...p.clips[0], mediaId: null }] });
  assert.equal(missing.clips[0].mediaId, '');
  assert.throws(() => validateProject(missing, library), /Relink/);
  assert.deepEqual(validateProject(p, Object.fromEntries(library)), p);
  assert.throws(() => validateProject(createProject(), library), /Add a video/);
});

test('strict export bounds source clips and source kinds', () => {
  const p = project([clip(video, 0, 20)]);
  assert.deepEqual(validateProject(p, library), p);
  assert.throws(
    () => validateProject({ ...p, clips: [{ ...p.clips[0], out: 20.01 }] }, library),
    /source video/,
  );
  assert.throws(
    () => validateProject({ ...p, clips: [{ ...p.clips[0], mediaId: music.id }] }, library),
    /media type/,
  );
});

test('image/video overlays validate source offsets, sound and finite video duration', () => {
  const base = project([clip(video, 0, 2)]),
    p = addOverlay(base, image, 1);
  assert.deepEqual(validateProject(p, library), p);
  assert.throws(
    () => validateProject({ ...p, overlays: [{ ...p.overlays[0], in: 1 }] }, library),
    /Image/,
  );
  assert.throws(
    () => validateProject({ ...p, overlays: [{ ...p.overlays[0], volume: 0.5 }] }, library),
    /Image/,
  );
  const overlay = addOverlay(base, video, 0);
  assert.throws(
    () =>
      validateProject(
        { ...overlay, overlays: [{ ...overlay.overlays[0], in: 19, duration: 2 }] },
        library,
      ),
    /source video/,
  );
  assert.throws(
    () =>
      validateProject(
        { ...overlay, overlays: [{ ...overlay.overlays[0], mediaId: silent.id, volume: 0.5 }] },
        library,
      ),
    /no audio/,
  );
  assert.doesNotThrow(() =>
    validateProject(
      { ...overlay, overlays: [{ ...overlay.overlays[0], in: 19, duration: 1 + 1 / 30 }] },
      library,
    ),
  );
});

test('nonloop audio may outlast the source; source offset and audio availability remain strict', () => {
  const p = addAudio(project([clip(video, 0, 20)]), music, 0);
  assert.equal(p.audio[0].duration, 4);
  assert.equal(p.audio[0].loop, false);
  const padded = normalizeProject({
    ...p,
    audio: [{ ...p.audio[0], loop: false, in: 3, duration: 20, fadeOut: 2 }],
  });
  assert.deepEqual(validateProject(padded, library), padded);
  assert.throws(
    () => validateProject({ ...p, audio: [{ ...p.audio[0], in: 4 }] }, library),
    /beyond its source/,
  );
  assert.throws(() => addAudio(p, silent, 0), /no audio/);
  assert.throws(() => addAudio(p, image, 0), /media type/);
});

test('a 210-second song stays whole over a 55-second video and can be cut down to a later section', () => {
  const song = { ...music, duration: 210 },
    movie = { ...video, duration: 55 },
    original = freeze(addAudio(project([clip(movie)]), song));
  assert.equal(original.audio[0].duration, 210);
  assert.equal(timelineDuration(original), 210);
  assert.equal(duration(original), 55);
  let p = splitAudio(original, original.audio[0].id, 80, song);
  const first = p.audio[0].id,
    middle = p.audio[1].id;
  p = splitAudio(p, middle, 135, song);
  const last = p.audio[2].id;
  assert.deepEqual(
    p.audio.map((a) => [a.start, a.in, a.duration]),
    [
      [0, 0, 80],
      [80, 80, 55],
      [135, 135, 75],
    ],
  );
  p = removeItem(removeItem(p, 'audio', first), 'audio', last);
  p.audio[0].start = 0;
  assert.deepEqual(
    validateProject(
      p,
      new Map([
        [song.id, song],
        [movie.id, movie],
      ]),
    ),
    p,
  );
  assert.equal(timelineDuration(p), 55);
  assert.equal(p.audio[0].in, 80);
  assert.deepEqual(p.clips, original.clips);
  assert.equal(original.audio.length, 1);
});

test('audio cuts preserve loop phase, gains and outer fades without adding a fade at the cut', () => {
  let p = addAudio(project([clip(video)]), music, 1);
  p.audio[0] = {
    ...p.audio[0],
    in: 3,
    duration: 12,
    loop: true,
    volume: 0.6,
    fadeIn: 0.2,
    fadeOut: 0.4,
  };
  const result = splitAudio(freeze(p), p.audio[0].id, 7, music);
  assert.equal(result.audio[0].id, p.audio[0].id);
  assert.notEqual(result.audio[1].id, p.audio[0].id);
  assert.deepEqual(
    result.audio.map((a) => [a.start, a.in, a.duration, a.fadeIn, a.fadeOut, a.volume]),
    [
      [1, 3, 6, 0.2, 0, 0.6],
      [7, 1, 6, 0, 0.4, 0.6],
    ],
  );
  assert.doesNotThrow(() => validateProject(result, library));
  for (const point of [1, 13, -1, NaN])
    assert.throws(() => splitAudio(p, p.audio[0].id, point, music), ModelError);
  assert.throws(() => splitAudio(p, randomUUID(), 7, music), ModelError);
  assert.throws(() => splitAudio(p, p.audio[0].id, 7, video), /Relink/);
  const silentTail = normalizeProject({ ...p, audio: [{ ...p.audio[0], loop: false }] });
  assert.throws(() => splitAudio(silentTail, p.audio[0].id, 7, music), /silent/);
  const full = normalizeProject({
    ...p,
    audio: Array.from({ length: 32 }, () => ({ ...p.audio[0], id: randomUUID() })),
  });
  assert.throws(() => splitAudio(full, full.audio[0].id, 7, music), /item count/);
});

test('audio edge trims stay within the source, preserve timing and support restoring either edge', () => {
  const original = freeze(addAudio(project([clip(video)]), music, 2)),
    id = original.audio[0].id;
  let p = trimAudio(original, id, 'start', 3, music);
  assert.deepEqual([p.audio[0].start, p.audio[0].in, p.audio[0].duration], [3, 1, 3]);
  p = trimAudio(p, id, 'end', 5, music);
  assert.equal(p.audio[0].duration, 2);
  p = trimAudio(p, id, 'end', 9999, music);
  assert.equal(p.audio[0].duration, 3);
  p = trimAudio(p, id, 'start', -99, music);
  assert.deepEqual(p, original);
  const tiny = trimAudio(original, id, 'end', 0, music);
  assert.ok(Math.abs(tiny.audio[0].duration - 1 / 30) < 1e-7);
  assert.throws(() => trimAudio(original, id, 'end', NaN, music), ModelError);
  const loop = normalizeProject({
    ...original,
    audio: [{ ...original.audio[0], loop: true, in: 3, duration: 10 }],
  });
  const loopTrim = trimAudio(loop, id, 'start', 4, music);
  assert.equal(loopTrim.audio[0].in, 1);
  assert.equal(loopTrim.audio[0].start + loopTrim.audio[0].duration, 12);
  assert.doesNotThrow(() => validateProject(loopTrim, library));
});

test('layers beyond a rippled main end remain export-valid and do not extend main duration', () => {
  let p = project([clip(video, 0, 20)]);
  p = addOverlay(p, image, 18);
  p = addAudio(p, music, 16);
  p = normalizeProject({ ...p, clips: [{ ...p.clips[0], out: 1 }] });
  assert.equal(duration(p), 1);
  assert.equal(p.overlays[0].start, 18);
  assert.equal(p.audio[0].start, 16);
  assert.deepEqual(validateProject(p, library), p);
});

test('dimensions, frame rates, item counts and one-hour bounds are enforced', () => {
  for (const options of [
    { width: 65 },
    { height: 4000 },
    { width: 3000, height: 3000 },
    { fps: 29.97 },
    { fps: 120 },
  ])
    assert.throws(() => createProject(options as never), ModelError);
  assert.equal(createProject({ width: 2160, height: 3840 }).width, 2160);
  const long = { ...video, duration: 7200 },
    full = appendClip(createProject({ fps: 60 }), long);
  assert.equal(duration(full), 3600);
  assert.equal(full.clips[0].out, 3600);
  assert.throws(() => duplicateItem(full, 'clip', full.clips[0].id), /one hour/);
  assert.throws(
    () =>
      normalizeProject({
        ...createProject(),
        clips: Array.from({ length: 129 }, () => clip(video, 0, 1)),
      }),
    /item count/,
  );
  const p = addOverlay(project([clip(video, 0, 1)]), image, 0);
  assert.throws(
    () => normalizeProject({ ...p, overlays: [{ ...p.overlays[0], start: 3599, duration: 2 }] }),
    /one-hour/,
  );
  assert.throws(
    () =>
      normalizeProject({
        ...p,
        overlays: Array.from({ length: 33 }, () => ({ ...p.overlays[0], id: randomUUID() })),
      }),
    /item count/,
  );
});

test('malformed ranges, unknown fields and duplicate item IDs are rejected', () => {
  const p = project([clip(video, 0, 1)]);
  for (const change of [
    { speed: 0 },
    { speed: 5 },
    { volume: NaN },
    { out: 0 },
    { fit: 'stretch' },
    { in: -1 },
    { in: '0' },
  ])
    assert.throws(
      () => normalizeProject({ ...p, clips: [{ ...p.clips[0], ...change }] }),
      ModelError,
    );
  assert.throws(() => normalizeProject({ ...p, path: 'C:/private.mp4' }), /unsupported field/);
  assert.throws(
    () => normalizeProject({ ...p, clips: [{ ...p.clips[0], url: 'https://example.invalid' }] }),
    /unsupported field/,
  );
  assert.throws(() => normalizeProject({ ...p, clips: [p.clips[0], p.clips[0]] }), /unique/);
  assert.throws(() => normalizeProject({ ...p, version: 1 }), /version/);
});

test('structural validation rejects custom prototypes, accessors, sparse arrays and prototype keys without executing them', () => {
  const p = project([clip(video, 0, 1)]);
  let calls = 0;
  const getter = { ...p };
  Object.defineProperty(getter, 'title', {
    get() {
      calls++;
      return 'Injected';
    },
    enumerable: true,
  });
  assert.throws(() => normalizeProject(getter), /getters/);
  assert.equal(calls, 0);
  assert.throws(
    () => normalizeProject(Object.assign(Object.create({ bad: true }), p)),
    /prototype/,
  );
  assert.throws(
    () =>
      normalizeProject(
        JSON.parse(JSON.stringify(p).replace('"version":2', '"version":2,"__proto__":{}')),
      ),
    /unsupported field/,
  );
  const array = [p.clips[0]];
  Object.defineProperty(array, '0', {
    get() {
      calls++;
      return p.clips[0];
    },
  });
  assert.throws(() => normalizeProject({ ...p, clips: array }), /getters/);
  assert.equal(calls, 0);
  assert.throws(() => normalizeProject({ ...p, clips: new Array(1) }), /gaps/);
  assert.equal(({} as { bad?: boolean }).bad, undefined);
});

test('all supported mutators return independent project and layer objects', () => {
  let p = project([clip(video, 0, 2), clip(video, 2, 4)]);
  p = addOverlay(p, image, 0);
  p = addAudio(p, music, 0);
  freeze(p);
  for (const next of [
    removeItem(p, 'audio', p.audio[0].id),
    duplicateItem(p, 'overlay', p.overlays[0].id),
    moveClip(p, p.clips[0].id, 1),
    appendClip(p, video),
    addOverlay(p, image, 2),
    addAudio(p, music, 2),
  ]) {
    assert.notEqual(next, p);
    assert.notEqual(next.clips, p.clips);
    assert.notEqual(next.clips[0], p.clips[0]);
    if (next.overlays.length) assert.notEqual(next.overlays[0], p.overlays[0]);
  }
});
