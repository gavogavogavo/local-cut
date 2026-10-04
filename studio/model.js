/** Pure shared project model. Source times are seconds; main-track positions
 * are quantized to output frames. Layers keep absolute timeline positions. */
export const PROJECT_VERSION = 2;
export const FRAME_RATES = Object.freeze([24, 25, 30, 50, 60]);
export const LIMITS = Object.freeze({
  clips: 128,
  overlays: 32,
  audio: 32,
  duration: 3600,
  frameArea: 8294400,
});
const EPS = 1e-7;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fields = {
  project: ['version', 'id', 'title', 'width', 'height', 'fps', 'clips', 'overlays', 'audio'],
  clip: ['id', 'mediaId', 'in', 'out', 'speed', 'volume', 'fit'],
  overlay: [
    'id',
    'mediaId',
    'start',
    'duration',
    'in',
    'x',
    'y',
    'width',
    'height',
    'opacity',
    'volume',
    'fadeIn',
    'fadeOut',
  ],
  audio: ['id', 'mediaId', 'start', 'in', 'duration', 'volume', 'loop', 'fadeIn', 'fadeOut'],
};
export class ModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelError';
  }
}
const fail = (message) => {
  throw new ModelError(message);
};
const freshId = () => globalThis.crypto.randomUUID();
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label} has an unsupported prototype.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key))
      fail(`${label} contains an unsupported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value'))
      fail(`${label} cannot contain getters or setters.`);
  }
  return value;
}
function number(value, label, min, max, fallback) {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${label} is outside its supported range.`);
  return value;
}
function id(value, label, fallback = false) {
  if (value === undefined && fallback) return freshId();
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`);
  return value;
}
function mediaId(value) {
  // A missing/unresolved reference is valid in a saved project, for relinking.
  if (value === undefined || value === null || value === '') return '';
  return id(value, 'Media reference');
}
function bool(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}
function list(value, label, maximum, transform) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum)
    fail(`${label} exceeds the supported item count.`);
  if (Object.getPrototypeOf(value) !== Array.prototype)
    fail(`${label} has an unsupported prototype.`);
  for (const key of Reflect.ownKeys(value)) {
    if (
      key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
    )
      fail(`${label} contains an unsupported field.`);
  }
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !own(descriptor, 'value'))
      fail(`${label} must contain plain items without getters or gaps.`);
    result.push(transform(descriptor.value));
  }
  return result;
}
function normalizeClip(value, fps) {
  const p = object(value, fields.clip, 'Clip');
  const result = {
    id: id(p.id, 'Clip ID', true),
    mediaId: mediaId(p.mediaId),
    in: number(p.in, 'Clip in', 0, 86400, 0),
    out: number(p.out, 'Clip out', 0, 86400),
    speed: number(p.speed, 'Clip speed', 0.25, 4, 1),
    volume: number(p.volume, 'Clip volume', 0, 1, 1),
    fit: p.fit === undefined ? 'contain' : p.fit,
  };
  if (!['contain', 'cover'].includes(result.fit)) fail('Clip fit must be contain or cover.');
  if ((result.out - result.in) / result.speed + EPS < 1 / fps)
    fail('Each clip must contain at least one output frame.');
  return result;
}
function layerTimes(p, label, fps) {
  const start = number(p.start, `${label} start`, 0, LIMITS.duration, 0);
  const duration = number(p.duration, `${label} duration`, 1 / fps - EPS, LIMITS.duration);
  if (start + duration > LIMITS.duration + EPS)
    fail(`${label} extends beyond the one-hour project limit.`);
  return { start, duration, in: number(p.in, `${label} source in`, 0, 86400, 0) };
}
function fades(p, duration, label) {
  return {
    fadeIn: number(p.fadeIn, `${label} fade in`, 0, duration, 0),
    fadeOut: number(p.fadeOut, `${label} fade out`, 0, duration, 0),
  };
}
function normalizeOverlay(value, fps) {
  const p = object(value, fields.overlay, 'Overlay'),
    times = layerTimes(p, 'Overlay', fps);
  return {
    id: id(p.id, 'Overlay ID', true),
    mediaId: mediaId(p.mediaId),
    ...times,
    x: number(p.x, 'Overlay X', -1, 1, 0.25),
    y: number(p.y, 'Overlay Y', -1, 1, 0.25),
    width: number(p.width, 'Overlay width', 0.01, 2, 0.5),
    height: number(p.height, 'Overlay height', 0.01, 2, 0.5),
    opacity: number(p.opacity, 'Overlay opacity', 0, 1, 1),
    volume: number(p.volume, 'Overlay volume', 0, 1, 0),
    ...fades(p, times.duration, 'Overlay'),
  };
}
function normalizeAudio(value, fps) {
  const p = object(value, fields.audio, 'Audio layer'),
    times = layerTimes(p, 'Audio layer', fps);
  return {
    id: id(p.id, 'Audio layer ID', true),
    mediaId: mediaId(p.mediaId),
    ...times,
    volume: number(p.volume, 'Audio volume', 0, 1, 0.25),
    loop: bool(p.loop, 'Audio loop', true),
    ...fades(p, times.duration, 'Audio'),
  };
}
/** Whitelist-only JSON normalization. It deliberately does not consult the
 * media library, so a saved project can be reopened and relinked later. */
export function normalizeProject(value) {
  const p = object(value, fields.project, 'Project');
  if (p.version !== PROJECT_VERSION) fail('This project version is not supported.');
  const width = number(p.width, 'Canvas width', 64, 3840, 1920),
    height = number(p.height, 'Canvas height', 64, 3840, 1080);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width % 2 ||
    height % 2 ||
    width * height > LIMITS.frameArea
  )
    fail('Use even canvas dimensions up to 4K (8,294,400 pixels).');
  const fps = number(p.fps, 'Frame rate', 24, 60, 60);
  if (!FRAME_RATES.includes(fps)) fail('Choose 24, 25, 30, 50 or 60 frames per second.');
  const title = p.title === undefined ? 'Untitled project' : p.title;
  if (typeof title !== 'string' || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title))
    fail('Use a project title of at most 200 characters without control characters.');
  const project = {
    version: PROJECT_VERSION,
    id: id(p.id, 'Project ID', true),
    title,
    width,
    height,
    fps,
    clips: list(p.clips, 'Main track', LIMITS.clips, (x) => normalizeClip(x, fps)),
    overlays: list(p.overlays, 'Overlay track', LIMITS.overlays, (x) => normalizeOverlay(x, fps)),
    audio: list(p.audio, 'Audio track', LIMITS.audio, (x) => normalizeAudio(x, fps)),
  };
  const ids = new Set();
  for (const item of [...project.clips, ...project.overlays, ...project.audio]) {
    if (ids.has(item.id)) fail('Timeline item IDs must be unique.');
    ids.add(item.id);
  }
  if (duration(project) > LIMITS.duration + EPS)
    fail('The main timeline may be at most one hour long.');
  return project;
}
export function createProject(options = {}) {
  return normalizeProject({ version: PROJECT_VERSION, ...options });
}
/** The tiny tolerance makes half-frame rounding stable after source-time
 * arithmetic; both native export and preview consume this same frame count. */
export function clipFrames(project, clip) {
  return Math.max(1, Math.floor(((clip.out - clip.in) / clip.speed) * project.fps + 0.5 + EPS));
}
export function duration(project) {
  return (
    project.clips.reduce((frames, clip) => frames + clipFrames(project, clip), 0) / project.fps
  );
}
/** Editing can reach the full music source; exports still end with the main video. */
export function timelineDuration(project) {
  return Math.max(
    duration(project),
    ...project.overlays.map((item) => item.start + item.duration),
    ...project.audio.map((item) => item.start + item.duration),
  );
}
export function clipStarts(project) {
  let frames = 0;
  return project.clips.map((clip) => {
    const start = frames / project.fps;
    frames += clipFrames(project, clip);
    return start;
  });
}
/** Half-open timeline intervals: the exact end is outside the main track. */
export function clipAt(project, time) {
  if (!Number.isFinite(time) || time < 0) return null;
  let frames = 0;
  for (let index = 0; index < project.clips.length; index++) {
    const clip = project.clips[index],
      start = frames / project.fps;
    frames += clipFrames(project, clip);
    const end = frames / project.fps;
    if (time >= start && time < end)
      return {
        clip,
        index,
        start,
        end,
        sourceTime: Math.min(clip.out, Math.max(clip.in, clip.in + (time - start) * clip.speed)),
      };
  }
  return null;
}
function collection(kind) {
  if (kind === 'clip') return 'clips';
  if (kind === 'overlay') return 'overlays';
  if (kind === 'audio') return 'audio';
  fail('Unknown timeline item type.');
}
export function splitClip(project, clipId, timeAbsolute) {
  const p = normalizeProject(project),
    index = p.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) fail('This clip is no longer on the timeline.');
  if (!Number.isFinite(timeAbsolute)) fail('Choose a valid cut time.');
  const clip = p.clips[index],
    start = clipStarts(p)[index],
    total = clipFrames(p, clip),
    leftFrames = Math.round((timeAbsolute - start) * p.fps);
  if (leftFrames < 1 || leftFrames >= total)
    fail('A cut must leave at least one frame on each side.');
  const cut = clip.in + (leftFrames / p.fps) * clip.speed;
  const left = { ...clip, out: cut },
    right = { ...clip, id: freshId(), in: cut };
  if (
    (right.out - right.in) / right.speed + EPS < 1 / p.fps ||
    (left.out - left.in) / left.speed + EPS < 1 / p.fps
  )
    fail('A cut must leave at least one source frame of output on each side.');
  if (clipFrames(p, left) + clipFrames(p, right) !== total)
    fail('This cut cannot preserve the clip’s exact frame duration.');
  p.clips.splice(index, 1, left, right);
  return normalizeProject(p);
}
function audioSource(project, itemId, media) {
  const index = project.audio.findIndex((item) => item.id === itemId);
  if (index < 0) fail('This audio is no longer on the timeline.');
  const item = project.audio[index],
    m = source(media, ['audio', 'music', 'video']);
  if (m.id !== item.mediaId) fail('Relink this audio source before editing it.');
  return { item, index, media: m };
}
export function splitAudio(project, itemId, timeAbsolute, media) {
  const p = normalizeProject(project),
    { item, index, media: m } = audioSource(p, itemId, media);
  if (!Number.isFinite(timeAbsolute)) fail('Choose a valid cut time.');
  const cut = Math.round(timeAbsolute * p.fps) / p.fps,
    leftDuration = cut - item.start,
    rightDuration = item.duration - leftDuration;
  if (Math.min(leftDuration, rightDuration) + EPS < 1 / p.fps)
    fail('Place the playhead inside the selected audio, with at least one frame on each side.');
  const offset = item.in + leftDuration;
  if (!item.loop && offset >= m.duration)
    fail('This part of the audio is silent. Choose a cut before the source ends.');
  p.audio.splice(
    index,
    1,
    { ...item, duration: leftDuration, fadeIn: Math.min(item.fadeIn, leftDuration), fadeOut: 0 },
    {
      ...item,
      id: freshId(),
      start: cut,
      in: item.loop ? offset % m.duration : offset,
      duration: rightDuration,
      fadeIn: 0,
      fadeOut: Math.min(item.fadeOut, rightDuration),
    },
  );
  return normalizeProject(p);
}
/** Trim a timeline edge without moving the source heard at the remaining times. */
export function trimAudio(project, itemId, edge, timeAbsolute, media) {
  const p = normalizeProject(project),
    { item, index, media: m } = audioSource(p, itemId, media);
  if (!['start', 'end'].includes(edge) || !Number.isFinite(timeAbsolute))
    fail('Choose a valid audio trim.');
  const frame = 1 / p.fps,
    end = item.start + item.duration,
    point = Math.round(timeAbsolute * p.fps) / p.fps,
    clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let start = item.start,
    offset = item.in,
    length;
  if (edge === 'start') {
    const earliest = item.loop ? 0 : Math.max(0, item.start - item.in),
      latest = item.loop
        ? end - frame
        : Math.min(end - frame, item.start + m.duration - item.in - frame);
    start = clamp(point, earliest, Math.max(earliest, latest));
    offset = item.in + start - item.start;
    if (item.loop) offset = ((offset % m.duration) + m.duration) % m.duration;
    length = end - start;
  } else {
    const latest = item.loop
      ? LIMITS.duration
      : Math.min(LIMITS.duration, item.start + m.duration - item.in);
    length = clamp(point, item.start + frame, Math.max(item.start + frame, latest)) - item.start;
  }
  p.audio[index] = {
    ...item,
    start,
    in: offset,
    duration: length,
    fadeIn: Math.min(item.fadeIn, length),
    fadeOut: Math.min(item.fadeOut, length),
  };
  return normalizeProject(p);
}
export function removeItem(project, kind, itemId) {
  const p = normalizeProject(project),
    key = collection(kind);
  p[key] = p[key].filter((item) => item.id !== itemId);
  return normalizeProject(p);
}
export function duplicateItem(project, kind, itemId) {
  const p = normalizeProject(project),
    key = collection(kind),
    index = p[key].findIndex((item) => item.id === itemId);
  if (index < 0) fail('This item is no longer on the timeline.');
  p[key].splice(index + 1, 0, { ...p[key][index], id: freshId() });
  return normalizeProject(p);
}
export function moveClip(project, clipId, newIndex) {
  const p = normalizeProject(project),
    index = p.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) fail('This clip is no longer on the timeline.');
  if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex > p.clips.length)
    fail('Choose a valid clip position.');
  const [clip] = p.clips.splice(index, 1);
  p.clips.splice(Math.min(newIndex, p.clips.length), 0, clip);
  return normalizeProject(p);
}
function source(media, allowedKinds) {
  if (!media || typeof media !== 'object' || !allowedKinds.includes(media.kind))
    fail('Choose a supported media type for this track.');
  id(media.id, 'Media ID');
  if (media.kind !== 'image') number(media.duration, 'Media duration', Number.EPSILON, 86400);
  return media;
}
export function appendClip(project, media) {
  const p = normalizeProject(project),
    m = source(media, ['video']),
    available = LIMITS.duration - duration(p);
  p.clips.push({
    id: freshId(),
    mediaId: m.id,
    in: 0,
    out: Math.min(m.duration, available),
    speed: 1,
    volume: 1,
    fit: 'contain',
  });
  return normalizeProject(p);
}
function addTimes(project, media, at, image = false) {
  const start = number(at, 'Layer start', 0, LIMITS.duration, 0),
    remaining = duration(project) - start;
  const wanted = image ? 5 : media.duration;
  return {
    start,
    duration: Math.min(
      LIMITS.duration - start,
      remaining > 0 ? Math.min(wanted, remaining) : wanted,
    ),
  };
}
export function addOverlay(project, media, at = 0) {
  const p = normalizeProject(project),
    m = source(media, ['image', 'video']),
    times = addTimes(p, m, at, m.kind === 'image');
  p.overlays.push({
    id: freshId(),
    mediaId: m.id,
    ...times,
    in: 0,
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
    opacity: 1,
    volume: 0,
    fadeIn: 0,
    fadeOut: 0,
  });
  return normalizeProject(p);
}
export function addAudio(project, media, at = 0) {
  const p = normalizeProject(project),
    m = source(media, ['audio', 'music', 'video']);
  if (m.kind === 'video' && !m.hasAudio) fail('This video has no audio track.');
  const start = number(at, 'Audio start', 0, LIMITS.duration, 0);
  p.audio.push({
    id: freshId(),
    mediaId: m.id,
    start,
    in: 0,
    duration: Math.min(LIMITS.duration - start, m.duration),
    volume: 0.25,
    loop: false,
    fadeIn: 0,
    fadeOut: 0,
  });
  return normalizeProject(p);
}
function lookupMedia(library, reference) {
  const media =
    library instanceof Map
      ? library.get(reference)
      : library && typeof library === 'object' && own(library, reference)
        ? library[reference]
        : undefined;
  if (!reference || !media) fail('Relink every referenced media file before exporting.');
  return media;
}
/** Export validation never discards an unresolved layer, including layers
 * beyond the current main duration; ripple edits may make them visible later. */
export function validateProject(value, mediaMap) {
  const p = normalizeProject(value);
  if (!p.clips.length) fail('Add a video clip before exporting.');
  for (const clip of p.clips) {
    const m = source(lookupMedia(mediaMap, clip.mediaId), ['video']);
    if (clip.out > m.duration + EPS) fail('A clip extends beyond its source video.');
  }
  for (const layer of p.overlays) {
    const m = source(lookupMedia(mediaMap, layer.mediaId), ['image', 'video']);
    if (m.kind === 'image') {
      if (layer.in !== 0 || layer.volume !== 0)
        fail('Image layers cannot have source offsets or audio.');
    } else {
      if (layer.in >= m.duration || layer.in + layer.duration > m.duration + 1 / p.fps + EPS)
        fail('An overlay extends beyond its source video.');
      if (layer.volume > 0 && !m.hasAudio) fail('This overlay video has no audio track.');
    }
  }
  for (const layer of p.audio) {
    const m = source(lookupMedia(mediaMap, layer.mediaId), ['audio', 'music', 'video']);
    if (m.kind === 'video' && !m.hasAudio) fail('This video has no audio track.');
    if (layer.in >= m.duration) fail('An audio layer starts beyond its source track.');
    // Non-looping tracks may be longer than the remaining source; export pads silence.
  }
  return p;
}
