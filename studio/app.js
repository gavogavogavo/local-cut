import {
  createProject,
  normalizeProject,
  validateProject,
  duration,
  timelineDuration,
  clipStarts,
  clipAt,
  clipFrames,
  appendClip,
  addOverlay,
  addAudio,
  splitClip,
  splitAudio,
  trimAudio,
  removeItem,
  duplicateItem,
  moveClip,
  FRAME_RATES,
} from './model.js';
import { StudioPreview } from './preview.js';
const $ = (id) => document.getElementById(id),
  clone = (value) => structuredClone(value),
  clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const state = {
  project: createProject({ fps: 30 }),
  media: new Map(),
  manifest: new Map(),
  selection: null,
  token: '',
  ready: false,
  history: [],
  future: [],
  zoom: 64,
  time: 0,
  playing: false,
  importing: false,
  upload: null,
  exporting: false,
  job: null,
  poll: null,
  saveTimer: null,
  saveChain: Promise.resolve(),
  revision: 0,
  savedRevision: 0,
  dragBase: null,
  relinkId: null,
  loading: false,
};
const collection = (kind) => ({ clip: 'clips', overlay: 'overlays', audio: 'audio' })[kind];
const allItems = () => [...state.project.clips, ...state.project.overlays, ...state.project.audio];
const missing = () =>
  [...new Set(allItems().map((i) => i.mediaId))].filter((id) => !state.media.has(id));
const selected = () =>
  state.selection
    ? state.project[collection(state.selection.kind)].find((i) => i.id === state.selection.id)
    : null;
const busy = () => state.importing || state.exporting || state.loading;
let preserveInspector = false;
function time(value, precise = true) {
  const ms = Math.max(0, Math.round((Number.isFinite(value) ? value : 0) * 1000)),
    h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${precise ? `.${String(ms % 1000).padStart(3, '0')}` : ''}`;
}
function parseTime(value) {
  const p = String(value).trim().replace(',', '.').split(':');
  if (p.length > 3 || p.some((v) => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(v))) return NaN;
  const numbers = p.map(Number);
  if (numbers.length > 1 && numbers.slice(1).some((n) => n >= 60)) return NaN;
  return numbers.reduce((a, n) => a * 60 + n, 0);
}
function tell(message) {
  $('message-text').textContent = message;
  $('message').hidden = false;
}
function announce(message) {
  $('announcement').textContent = message;
}
const mediaName = (id) =>
  state.media.get(id)?.name || state.manifest.get(id)?.name || 'Missing media';
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, action, className = 'button quiet small', label) {
  const b = node('button', className, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.disabled = busy();
  b.addEventListener('click', () => guard(action));
  return b;
}
function guard(action) {
  try {
    const result = action();
    if (result?.catch) result.catch((e) => tell(e.message || String(e)));
  } catch (e) {
    tell(e.message || String(e));
  }
}
async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' ? { 'X-Editor-Token': state.token } : {}),
      ...options.headers,
    },
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(
      data?.error?.message || data?.error || data?.message || `Request failed (${r.status}).`,
    );
    e.status = r.status;
    throw e;
  }
  return data;
}
const preview = new StudioPreview({
  canvas: $('preview-canvas'),
  surface: $('preview-surface'),
  stage: $('preview-stage'),
  box: $('selection-box'),
  label: $('selection-label'),
  resizeHandle: $('resize-layer'),
  onTime: updateTime,
  onSelect: select,
  onTransform: transformOverlay,
  onError: tell,
});

function updateTime(value, playing) {
  state.time = value;
  state.playing = playing;
  if (document.activeElement !== $('playhead-time')) $('playhead-time').value = time(value);
  $('play').textContent = playing ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause project' : 'Play project');
  $('timeline-playhead').style.left = `${value * state.zoom}px`;
  $('ruler').setAttribute('aria-valuenow', String(value));
  $('ruler').setAttribute('aria-valuetext', time(value));
  if (playing) {
    const scroll = $('timeline-scroll'),
      x = value * state.zoom;
    if (x > scroll.scrollLeft + scroll.clientWidth - 25 || x < scroll.scrollLeft)
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.25);
  }
}
function select(selection) {
  if (busy()) return;
  state.selection = selection;
  preview.setSelection(selection);
  renderInspector();
  renderTimeline();
  updateControls();
}
function remember(project) {
  state.history.push(clone(project));
  if (state.history.length > 80) state.history.shift();
  state.future = [];
}
function commit(project, { history = true } = {}) {
  if (busy()) return;
  const next = normalizeProject(project);
  if (JSON.stringify(next) === JSON.stringify(state.project)) return;
  preview.pause();
  if (history) remember(state.project);
  state.project = next;
  if (state.selection && !selected()) state.selection = null;
  state.revision++;
  render();
  scheduleSave();
  markOldExport();
}
function mutate(action) {
  const p = clone(state.project);
  action(p);
  commit(p);
}
function updateItem(patch) {
  const item = selected();
  if (!item) return;
  mutate((p) => {
    const key = collection(state.selection.kind),
      i = p[key].findIndex((c) => c.id === item.id);
    p[key][i] = { ...p[key][i], ...patch };
  });
}
function undo() {
  if (busy() || !state.history.length) return;
  preview.pause();
  state.future.push(clone(state.project));
  state.project = state.history.pop();
  if (state.selection && !selected()) state.selection = null;
  state.revision++;
  render();
  scheduleSave();
  markOldExport();
}
function redo() {
  if (busy() || !state.future.length) return;
  preview.pause();
  state.history.push(clone(state.project));
  state.project = state.future.pop();
  if (state.selection && !selected()) state.selection = null;
  state.revision++;
  render();
  scheduleSave();
  markOldExport();
}
function markOldExport() {
  if (state.job?.status === 'complete' && !state.exporting) {
    $('job-title').textContent = 'Previous export';
    $('job-detail').textContent =
      'This download is from an earlier version of the edit. Export again to include your changes.';
  }
}
function scheduleSave() {
  clearTimeout(state.saveTimer);
  $('save-state').textContent = 'Unsaved changes';
  state.saveTimer = setTimeout(() => void saveNow(), 650);
}
async function saveNow() {
  if (!state.ready) return false;
  clearTimeout(state.saveTimer);
  const p = clone(state.project),
    revision = state.revision;
  $('save-state').textContent = 'Saving…';
  state.saveChain = state.saveChain
    .catch(() => {})
    .then(() =>
      api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ project: p }),
      }),
    )
    .then(() => {
      try {
        localStorage.setItem('local-cut.last-project', p.id);
      } catch {}
      if (state.project.id === p.id && state.revision === revision) {
        state.savedRevision = revision;
        $('save-state').textContent = 'Saved on this computer';
      }
      return true;
    })
    .catch((e) => {
      $('save-state').textContent = 'Could not save';
      tell(`Autosave failed: ${e.message}`);
      return false;
    });
  return await state.saveChain;
}
function render() {
  const focus = document.activeElement?.matches('input,select') ? document.activeElement.id : null;
  if (document.activeElement !== $('project-title')) $('project-title').value = state.project.title;
  document.title = `${state.project.title || 'Untitled project'} · Local Cut`;
  $('project-duration').textContent = time(duration(state.project));
  $('project-dimensions').textContent =
    `${state.project.width} × ${state.project.height} · ${state.project.fps} fps`;
  $('preview-empty').hidden = state.project.clips.length > 0;
  preview.setProject(state.project, state.media);
  preview.setSelection(state.selection);
  renderMedia();
  if (!preserveInspector) renderInspector();
  renderTimeline();
  updateControls();
  updateTime(preview.time, preview.playing);
  if (focus && $(focus) && !$(focus).disabled) $(focus).focus({ preventScroll: true });
}
function updateControls() {
  const blocked = busy() || !state.ready,
    hasClips = state.project.clips.length > 0,
    missingSources = missing(),
    item = selected();
  for (const id of [
    'import-media',
    'projects',
    'save-project',
    'project-settings',
    'project-title',
  ])
    $(id).disabled = blocked;
  for (const id of ['play', 'frame-back', 'frame-forward', 'playhead-time'])
    $(id).disabled = blocked || !timelineDuration(state.project) || missingSources.length > 0;
  $('export-open').disabled = blocked || !hasClips || missingSources.length > 0;
  $('undo').disabled = blocked || !state.history.length;
  $('redo').disabled = blocked || !state.future.length;
  $('split').disabled = blocked || (state.selection?.kind === 'audio' ? !item : !hasClips);
  $('split').title =
    state.selection?.kind === 'audio'
      ? 'Split selected audio at playhead (S)'
      : 'Split video at playhead (S)';
  $('duplicate').disabled = $('delete').disabled = blocked || !item;
  const index =
    state.selection?.kind === 'clip'
      ? state.project.clips.findIndex((c) => c.id === state.selection.id)
      : -1;
  $('move-left').disabled = blocked || index <= 0;
  $('move-right').disabled = blocked || index < 0 || index >= state.project.clips.length - 1;
  $('missing-banner').hidden = !missingSources.length;
  $('missing-text').textContent =
    `${missingSources.length} source ${missingSources.length === 1 ? 'file is' : 'files are'} missing. Relink to preview or export.`;
  $('preview-status').textContent = state.exporting
    ? 'Exporting'
    : missingSources.length
      ? 'Missing media'
      : hasClips
        ? `${state.project.clips.length} clip${state.project.clips.length === 1 ? '' : 's'}`
        : 'No clips';
  document.body.classList.toggle('busy', busy());
  $('asset-summary').textContent =
    `${state.media.size} local file${state.media.size === 1 ? '' : 's'} · ${state.project.overlays.length} visual layer${state.project.overlays.length === 1 ? '' : 's'} · ${state.project.audio.length} audio layer${state.project.audio.length === 1 ? '' : 's'}`;
}
function renderMedia() {
  const bin = $('media-bin');
  bin.replaceChildren();
  $('media-count').textContent = `${state.media.size} files`;
  if (!state.media.size) {
    const empty = node('div', 'bin-empty');
    empty.append(
      node('span', '', '▧'),
      node('p', '', 'Drop video, images, or music here.'),
      node('small', '', 'Files stay on this computer.'),
    );
    bin.append(empty);
    return;
  }
  for (const m of state.media.values()) {
    const card = node('div', 'media-card');
    card.dataset.mediaId = m.id;
    const head = node('div', 'media-card-head'),
      thumb = node(
        'span',
        'media-thumb',
        m.kind === 'image' ? '▧' : m.kind === 'video' ? '▶' : '♫',
      );
    if (m.kind === 'image') {
      thumb.textContent = '';
      const image = new Image();
      image.src = m.url;
      image.alt = '';
      thumb.append(image);
    }
    const copy = node('div', 'media-copy'),
      name = node('strong', '', m.name);
    name.title = m.name;
    copy.append(
      name,
      node(
        'small',
        '',
        m.kind === 'image'
          ? `${m.width} × ${m.height}`
          : `${time(m.duration, false)}${m.width ? ` · ${m.width} × ${m.height}` : ''}`,
      ),
    );
    head.append(thumb, copy);
    card.append(head);
    const actions = node('div', 'media-actions');
    if (m.kind === 'video')
      actions.append(
        button('+ Clip', () => addMedia('clip', m), '', `Add ${m.name} to main track`),
      );
    if (m.kind === 'video' || m.kind === 'image')
      actions.append(
        button('+ Layer', () => addMedia('overlay', m), '', `Add ${m.name} as an overlay`),
      );
    if (m.kind === 'music' || m.kind === 'audio' || m.hasAudio)
      actions.append(button('+ Audio', () => addMedia('audio', m), '', `Add ${m.name} as audio`));
    const remove = button(
      '×',
      () => removeMedia(m),
      'media-remove',
      `Remove unused working copy of ${m.name}`,
    );
    remove.disabled = busy() || allItems().some((i) => i.mediaId === m.id);
    remove.title = remove.disabled ? 'Used by this project' : 'Remove this local working copy';
    actions.append(remove);
    card.append(actions);
    bin.append(card);
  }
}
function addMedia(kind, media) {
  if (busy()) return;
  let p = state.project;
  if (kind === 'clip' && !p.clips.length && media.width && media.height) {
    const width = clamp(Math.round(media.width / 2) * 2, 64, 3840),
      height = clamp(Math.round(media.height / 2) * 2, 64, 3840);
    if (width * height <= 8294400)
      p = {
        ...p,
        width,
        height,
        fps: FRAME_RATES.reduce(
          (a, b) => (Math.abs(b - media.fps) < Math.abs(a - media.fps) ? b : a),
          30,
        ),
      };
  }
  const next =
    kind === 'clip'
      ? appendClip(p, media)
      : kind === 'overlay'
        ? addOverlay(p, media, state.time)
        : addAudio(p, media, state.time);
  commit(next);
  const added = next[collection(kind)].at(-1);
  select({ kind, id: added.id });
  if (kind !== 'clip') preview.seek(added.start);
  announce(`${media.name} added.`);
}
async function removeMedia(media) {
  if (allItems().some((i) => i.mediaId === media.id))
    throw new Error('Remove this source’s timeline items before deleting its working copy.');
  if (
    !confirm(
      `Remove the editor’s working copy of “${media.name}”? Your original file will not be changed.`,
    )
  )
    return;
  await api(`/api/media/${encodeURIComponent(media.id)}`, { method: 'DELETE' });
  state.media.delete(media.id);
  render();
}

function field(
  parent,
  label,
  value,
  change,
  { id, type = 'number', min, max, step = 'any', suffix, options, range = false, format } = {},
) {
  const wrapper = node('label', 'field'),
    title = node('span', range ? 'field-value' : '', label);
  let output;
  if (range) {
    output = node('output', '', format ? format(value) : String(value));
    title.append(output);
  }
  wrapper.append(title);
  let input;
  if (options) {
    input = document.createElement('select');
    for (const [val, text] of options) {
      const opt = node('option', '', text);
      opt.value = String(val);
      input.append(opt);
    }
    input.value = String(value);
  } else {
    input = document.createElement('input');
    input.type = range ? 'range' : type;
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    if (type === 'text') input.spellcheck = false;
  }
  if (id) input.id = id;
  input.setAttribute('aria-label', label);
  input.disabled = busy();
  input.dataset.edit = 'true';
  if (suffix) {
    const unit = node('div', 'input-unit');
    unit.append(input, node('span', '', suffix));
    wrapper.append(unit);
  } else wrapper.append(input);
  if (range)
    input.addEventListener('input', () => {
      output.textContent = format ? format(Number(input.value)) : input.value;
    });
  input.addEventListener('change', () =>
    guard(() => {
      try {
        preserveInspector = range;
        change(
          options ? input.value : type === 'text' && !range ? input.value : Number(input.value),
        );
      } catch (e) {
        renderInspector();
        throw e;
      } finally {
        preserveInspector = false;
      }
    }),
  );
  parent.append(wrapper);
  return input;
}
function row(parent) {
  const r = node('div', 'input-row');
  parent.append(r);
  return r;
}
function timeField(parent, label, value, change, id) {
  field(
    parent,
    label,
    time(value),
    (raw) => {
      const parsed = parseTime(raw);
      if (!Number.isFinite(parsed)) throw new Error('Enter seconds or a time such as 00:12.500.');
      change(parsed);
    },
    { type: 'text', id },
  );
}
function renderInspector() {
  const content = $('inspector-content');
  content.replaceChildren();
  const item = selected(),
    kind = state.selection?.kind;
  if (!item) {
    $('inspector-title').textContent = 'Canvas';
    $('inspector-kind').textContent = 'PROJECT';
    field(
      content,
      'Canvas shape',
      state.project.width === state.project.height
        ? 'square'
        : state.project.width > state.project.height
          ? 'landscape'
          : 'portrait',
      (shape) => {
        const sizes = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };
        mutate((p) => {
          [p.width, p.height] = sizes[shape];
        });
      },
      {
        id: 'canvas-shape',
        options: [
          ['landscape', 'Landscape · 16:9'],
          ['portrait', 'Portrait · 9:16'],
          ['square', 'Square · 1:1'],
        ],
      },
    );
    const size = row(content);
    field(size, 'Width', state.project.width, (value) => mutate((p) => (p.width = value)), {
      id: 'canvas-width',
      min: 64,
      max: 3840,
      step: 2,
      suffix: 'px',
    });
    field(size, 'Height', state.project.height, (value) => mutate((p) => (p.height = value)), {
      id: 'canvas-height',
      min: 64,
      max: 3840,
      step: 2,
      suffix: 'px',
    });
    field(
      content,
      'Frame rate',
      state.project.fps,
      (value) => mutate((p) => (p.fps = Number(value))),
      { id: 'canvas-fps', options: FRAME_RATES.map((fps) => [fps, `${fps} fps`]) },
    );
    content.append(
      node(
        'p',
        'inspector-note',
        'Clips play one after another on the main track. Layers and music use their own start times. Select a timeline item to edit it.',
      ),
    );
    return;
  }
  const media = state.media.get(item.mediaId);
  $('inspector-title').textContent =
    kind === 'clip' ? 'Video clip' : kind === 'overlay' ? 'Visual layer' : 'Audio layer';
  $('inspector-kind').textContent = media?.kind?.toUpperCase() || 'MISSING';
  const source = node('div', 'inspector-source', mediaName(item.mediaId));
  source.append(
    node(
      'small',
      '',
      media
        ? media.kind === 'image'
          ? `${media.width} × ${media.height}`
          : `Source ${time(media.duration)}`
        : 'Relink this source to preview or export.',
    ),
  );
  content.append(source);
  if (!media) {
    content.append(button('Relink source', () => openRelink(), 'button secondary'));
    return;
  }
  if (kind === 'clip') {
    const times = row(content);
    timeField(
      times,
      'Source in',
      item.in,
      (value) => updateItem({ in: clamp(value, 0, item.out - item.speed / state.project.fps) }),
      'clip-in',
    );
    timeField(
      times,
      'Source out',
      item.out,
      (value) =>
        updateItem({ out: clamp(value, item.in + item.speed / state.project.fps, media.duration) }),
      'clip-out',
    );
    field(
      content,
      'Speed',
      item.speed,
      (value) =>
        updateItem({
          speed: clamp(value, 0.25, Math.min(4, (item.out - item.in) * state.project.fps)),
        }),
      { id: 'clip-speed', min: 0.25, max: 4, step: 0.25, suffix: '×' },
    );
    field(content, 'Fit to canvas', item.fit, (value) => updateItem({ fit: value }), {
      id: 'clip-fit',
      options: [
        ['contain', 'Fit · show whole image'],
        ['cover', 'Fill · crop to canvas'],
      ],
    });
    const volume = field(
      content,
      'Original audio',
      item.volume,
      (value) => updateItem({ volume: value }),
      {
        id: 'clip-volume',
        range: true,
        min: 0,
        max: 1,
        step: 0.01,
        format: (v) => `${Math.round(v * 100)}%`,
      },
    );
    if (!media.hasAudio) volume.disabled = true;
    content.append(
      node(
        'p',
        'inspector-note',
        `${time(clipFrames(state.project, item) / state.project.fps)} on timeline. Splitting or deleting a clip closes gaps in the main track; other layers keep their own start times.`,
      ),
    );
  } else {
    const times = row(content);
    timeField(
      times,
      'Timeline start',
      item.start,
      (value) => updateItem({ start: clamp(value, 0, 3600 - item.duration) }),
      'layer-start',
    );
    timeField(
      times,
      'Duration',
      item.duration,
      (value) => {
        let length = clamp(value, 1 / state.project.fps, 3600 - item.start);
        if (kind === 'overlay' && media.kind === 'video')
          length = Math.min(length, media.duration - item.in);
        updateItem({
          duration: length,
          fadeIn: Math.min(item.fadeIn, length),
          fadeOut: Math.min(item.fadeOut, length),
        });
      },
      'layer-duration',
    );
    if (media.kind !== 'image')
      timeField(
        content,
        kind === 'audio' ? 'Start in song' : 'Source in',
        item.in,
        (value) => {
          const max = kind === 'overlay' ? media.duration - item.duration : media.duration - 0.001;
          const offset = clamp(value, 0, Math.max(0, max));
          if (kind === 'audio' && !item.loop) {
            const length = Math.min(item.duration, media.duration - offset);
            if (length < 1 / state.project.fps)
              throw new Error('Leave at least one frame of audio.');
            updateItem({
              in: offset,
              duration: length,
              fadeIn: Math.min(item.fadeIn, length),
              fadeOut: Math.min(item.fadeOut, length),
            });
          } else updateItem({ in: offset });
        },
        'layer-in',
      );
    if (kind === 'overlay') {
      const position = row(content);
      field(
        position,
        'X position',
        Math.round(item.x * 10000) / 100,
        (value) => updateItem({ x: clamp(value / 100, -1, 1) }),
        { id: 'layer-x', min: -100, max: 100, step: 0.1, suffix: '%' },
      );
      field(
        position,
        'Y position',
        Math.round(item.y * 10000) / 100,
        (value) => updateItem({ y: clamp(value / 100, -1, 1) }),
        { id: 'layer-y', min: -100, max: 100, step: 0.1, suffix: '%' },
      );
      const size = row(content);
      field(
        size,
        'Width',
        Math.round(item.width * 10000) / 100,
        (value) => updateItem({ width: clamp(value / 100, 0.01, 2) }),
        { id: 'layer-width', min: 1, max: 200, step: 0.1, suffix: '%' },
      );
      field(
        size,
        'Height',
        Math.round(item.height * 10000) / 100,
        (value) => updateItem({ height: clamp(value / 100, 0.01, 2) }),
        { id: 'layer-height', min: 1, max: 200, step: 0.1, suffix: '%' },
      );
      field(content, 'Opacity', item.opacity, (value) => updateItem({ opacity: value }), {
        id: 'layer-opacity',
        range: true,
        min: 0,
        max: 1,
        step: 0.01,
        format: (v) => `${Math.round(v * 100)}%`,
      });
      const order = node('div', 'layer-order'),
        index = state.project.overlays.findIndex((o) => o.id === item.id);
      const back = button('Move back', () => reorderLayer(-1)),
        front = button('Move forward', () => reorderLayer(1));
      back.disabled = busy() || index <= 0;
      front.disabled = busy() || index >= state.project.overlays.length - 1;
      order.append(back, front);
      content.append(order);
    } else {
      if (!item.loop)
        timeField(
          content,
          'End in song',
          Math.min(media.duration, item.in + item.duration),
          (value) => {
            const length = clamp(
              value - item.in,
              1 / state.project.fps,
              Math.min(media.duration - item.in, 3600 - item.start),
            );
            updateItem({
              duration: length,
              fadeIn: Math.min(item.fadeIn, length),
              fadeOut: Math.min(item.fadeOut, length),
            });
          },
          'audio-out',
        );
      const actions = node('div', 'audio-actions');
      const full = button(
        'Use full song',
        () => {
          const length = Math.min(media.duration, 3600 - item.start);
          updateItem({
            in: 0,
            duration: length,
            loop: false,
            fadeIn: Math.min(item.fadeIn, length),
            fadeOut: Math.min(item.fadeOut, length),
          });
        },
        'button secondary small',
      );
      full.id = 'audio-full';
      const fit = button(
        'Fit to video',
        () => {
          const remaining = duration(state.project) - item.start,
            length = Math.min(remaining, item.loop ? remaining : media.duration - item.in);
          updateItem({
            duration: length,
            fadeIn: Math.min(item.fadeIn, length),
            fadeOut: Math.min(item.fadeOut, length),
          });
        },
        'button secondary small',
      );
      fit.id = 'audio-fit';
      fit.disabled =
        busy() ||
        duration(state.project) - item.start < 1 / state.project.fps ||
        (!item.loop && media.duration - item.in < 1 / state.project.fps);
      actions.append(full, fit);
      content.append(actions);
      const label = node('label', 'check-field'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'audio-loop';
      input.checked = item.loop;
      input.disabled = busy();
      input.addEventListener('change', () => guard(() => updateItem({ loop: input.checked })));
      label.append(input, node('span', '', 'Loop the whole source track'));
      content.append(label);
    }
    if (media.kind !== 'image') {
      const volume = field(
        content,
        'Volume',
        item.volume,
        (value) => updateItem({ volume: value }),
        {
          id: 'layer-volume',
          range: true,
          min: 0,
          max: 1,
          step: 0.01,
          format: (v) => `${Math.round(v * 100)}%`,
        },
      );
      if (media.kind === 'video' && !media.hasAudio) volume.disabled = true;
    }
    const fade = row(content);
    field(
      fade,
      'Fade in',
      item.fadeIn,
      (value) => updateItem({ fadeIn: clamp(value, 0, item.duration) }),
      { id: 'layer-fade-in', min: 0, max: item.duration, step: 0.1, suffix: 'sec' },
    );
    field(
      fade,
      'Fade out',
      item.fadeOut,
      (value) => updateItem({ fadeOut: clamp(value, 0, item.duration) }),
      { id: 'layer-fade-out', min: 0, max: item.duration, step: 0.1, suffix: 'sec' },
    );
    content.append(
      node(
        'p',
        'inspector-note',
        kind === 'overlay'
          ? 'Drag the selected layer in the preview to move it; drag its corner to resize. Fades affect its picture and sound.'
          : 'Select audio and press S to cut at the playhead. Drag either edge to trim; drag the middle to move it. Start in song chooses a later section. Export ends with the video.',
      ),
    );
  }
}
function reorderLayer(delta) {
  const item = selected();
  if (state.selection?.kind !== 'overlay' || !item) return;
  mutate((p) => {
    const i = p.overlays.findIndex((l) => l.id === item.id),
      [layer] = p.overlays.splice(i, 1);
    p.overlays.splice(clamp(i + delta, 0, p.overlays.length), 0, layer);
  });
}
function transformOverlay(item, phase) {
  if (busy()) return;
  if (phase === 'start') {
    state.dragBase = clone(state.project);
    return;
  }
  if (phase === 'update') {
    state.project = {
      ...state.project,
      overlays: state.project.overlays.map((l) => (l.id === item.id ? item : l)),
    };
    preview.setProject(state.project, state.media);
    return;
  }
  if (state.dragBase) {
    const before = state.dragBase;
    state.dragBase = null;
    if (JSON.stringify(before) !== JSON.stringify(state.project)) {
      remember(before);
      state.revision++;
      render();
      scheduleSave();
      markOldExport();
    }
  }
}

function renderTimeline() {
  const p = state.project,
    total = duration(p),
    extent = Math.max(8, timelineDuration(p)),
    width = Math.max(200, extent * state.zoom + 60);
  $('timeline-content').style.width = `${width}px`;
  $('ruler').setAttribute('aria-valuemax', String(timelineDuration(p)));
  $('ruler').replaceChildren();
  const step = Math.max(
    state.zoom >= 100 ? 0.5 : state.zoom >= 40 ? 1 : 5,
    Math.ceil(extent / 200),
    Math.ceil(60 / state.zoom),
  );
  for (let t = 0; t <= extent; t += step) {
    const mark = node('div', 'ruler-tick');
    mark.style.left = `${t * state.zoom}px`;
    mark.append(node('span', '', time(t, false)));
    $('ruler').append(mark);
  }
  if (total && timelineDuration(p) > total) {
    const end = node('div', 'video-end-marker', 'Video ends');
    end.style.left = `${total * state.zoom}px`;
    $('ruler').append(end);
  }
  const labels = $('track-labels'),
    tracks = $('tracks');
  labels.replaceChildren(node('div', 'track-label-spacer'));
  tracks.replaceChildren();
  function track(label, main = false) {
    const l = node('div', `track-label${main ? ' main-label' : ''}`, label);
    labels.append(l);
    const tr = node('div', `track${main ? ' main-track' : ''}`);
    const shade = node('div', 'track-end-shade');
    shade.style.left = `${total * state.zoom}px`;
    shade.style.right = '0';
    tr.append(shade);
    tr.addEventListener('pointerdown', (e) => {
      if (e.target === tr || e.target === shade) {
        const r = tr.getBoundingClientRect();
        preview.pause();
        preview.seek(clamp((e.clientX - r.left) / state.zoom, 0, timelineDuration(p)));
        select(null);
      }
    });
    tracks.append(tr);
    return tr;
  }
  const main = track('MAIN VIDEO', true),
    starts = clipStarts(p);
  if (!p.clips.length)
    main.append(node('span', 'track-placeholder', 'Add a video from your media library'));
  p.clips.forEach((item, index) =>
    timelineItem(main, item, 'clip', starts[index], clipFrames(p, item) / p.fps, index),
  );
  if (!p.overlays.length) {
    const tr = track('LAYERS');
    tr.append(node('span', 'track-placeholder', 'Images and video overlays'));
  } else
    p.overlays.forEach((item, index) =>
      timelineItem(track(`LAYER ${index + 1}`), item, 'overlay', item.start, item.duration, index),
    );
  if (!p.audio.length) {
    const tr = track('AUDIO');
    tr.append(node('span', 'track-placeholder', 'Music and additional audio'));
  } else
    p.audio.forEach((item, index) =>
      timelineItem(track(`AUDIO ${index + 1}`), item, 'audio', item.start, item.duration, index),
    );
  updateTime(state.time, state.playing);
}
function timelineItem(track, item, kind, start, length, index) {
  const b = node(
    'button',
    `timeline-item ${kind}${state.selection?.id === item.id ? ' selected' : ''}${state.media.has(item.mediaId) ? '' : ' missing'}`,
  );
  b.type = 'button';
  b.dataset.itemId = item.id;
  b.dataset.kind = kind;
  b.setAttribute(
    'aria-label',
    `${kind} ${index + 1}: ${mediaName(item.mediaId)}, starts ${time(start)}, duration ${time(length)}`,
  );
  b.style.left = `${start * state.zoom}px`;
  b.style.width = `${Math.max(4, length * state.zoom - 2)}px`;
  b.title = `${mediaName(item.mediaId)} · ${time(start)} – ${time(start + length)}`;
  b.append(
    node('strong', '', mediaName(item.mediaId)),
    node(
      'small',
      '',
      kind === 'clip'
        ? `${time(length, false)}${item.speed !== 1 ? ` · ${item.speed}×` : ''}`
        : time(length, false),
    ),
  );
  b.disabled = busy();
  if (kind === 'audio' && state.media.has(item.mediaId)) {
    for (const edge of ['start', 'end']) {
      const handle = node('span', `audio-trim audio-trim-${edge}`);
      handle.dataset.trim = edge;
      handle.title = `Drag to trim audio ${edge}`;
      handle.setAttribute('aria-hidden', 'true');
      b.append(handle);
    }
    b.title += ` · Song ${time(item.in)} – ${time(item.in + length)} · Drag edges to trim`;
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!b.dataset.dragged) select({ kind, id: item.id });
  });
  if (kind === 'clip') {
    b.draggable = !busy();
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-studio-clip', item.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    b.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-studio-clip')) {
        e.preventDefault();
        b.classList.add('drop-target');
      }
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.remove('drop-target');
      const id = e.dataTransfer.getData('application/x-studio-clip');
      if (id)
        guard(() => {
          commit(moveClip(state.project, id, index));
          select({ kind: 'clip', id });
        });
    });
  } else
    b.addEventListener('pointerdown', (e) => {
      if (busy() || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      preview.pause();
      state.selection = { kind, id: item.id };
      preview.setSelection(state.selection);
      renderInspector();
      const before = clone(state.project),
        origin = e.clientX,
        initial = item.start,
        edge = kind === 'audio' ? e.target.closest('[data-trim]')?.dataset.trim : null;
      let changed = false;
      let ended = false;
      b.setPointerCapture(e.pointerId);
      const move = (event) => {
        if (!(event.buttons & 1)) {
          end();
          return;
        }
        const delta = (event.clientX - origin) / state.zoom;
        if (Math.abs(event.clientX - origin) > 3) changed = true;
        if (!changed) return;
        if (edge) {
          state.project = trimAudio(
            before,
            item.id,
            edge,
            initial + (edge === 'end' ? item.duration : 0) + delta,
            state.media.get(item.mediaId),
          );
        } else {
          const start = clamp(
            Math.round((initial + delta) * state.project.fps) / state.project.fps,
            0,
            3600 - item.duration,
          );
          state.project = {
            ...state.project,
            [collection(kind)]: state.project[collection(kind)].map((l) =>
              l.id === item.id ? { ...l, start } : l,
            ),
          };
        }
        const changedItem = selected();
        b.style.left = `${changedItem.start * state.zoom}px`;
        b.style.width = `${Math.max(4, changedItem.duration * state.zoom - 2)}px`;
        b.dataset.dragged = 'true';
        preview.setProject(state.project, state.media);
      };
      const end = () => {
        if (ended) return;
        ended = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        b.removeEventListener('lostpointercapture', end);
        if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
        if (changed && JSON.stringify(state.project) !== JSON.stringify(before)) {
          remember(before);
          state.revision++;
          scheduleSave();
          markOldExport();
        }
        render();
        if (edge) announce(`Audio trimmed to ${time(selected().duration)}.`);
      };
      b.addEventListener('lostpointercapture', end);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
    });
  track.append(b);
}
function split() {
  if (busy()) return;
  if (state.selection?.kind === 'audio') {
    const item = selected();
    if (!item) return;
    const next = splitAudio(state.project, item.id, state.time, state.media.get(item.mediaId)),
      index = next.audio.findIndex((audio) => audio.id === item.id);
    commit(next);
    select({ kind: 'audio', id: next.audio[index + 1].id });
    announce('Audio split. Select either piece to move, trim, or delete it.');
    return;
  }
  const active = clipAt(state.project, state.time);
  if (!active) throw new Error('Place the playhead inside a video clip to split it.');
  commit(splitClip(state.project, active.clip.id, state.time));
  select({ kind: 'clip', id: active.clip.id });
}
function deleteSelected() {
  if (!state.selection || busy()) return;
  const { kind, id } = state.selection;
  commit(removeItem(state.project, kind, id));
  announce('Timeline item deleted. The source file is still in Media.');
}
function duplicateSelected() {
  if (!state.selection || busy()) return;
  const { kind, id } = state.selection,
    index = state.project[collection(kind)].findIndex((i) => i.id === id),
    next = duplicateItem(state.project, kind, id);
  commit(next);
  select({ kind, id: next[collection(kind)][index + 1].id });
}
function moveSelected(delta) {
  if (state.selection?.kind !== 'clip' || busy()) return;
  const index = state.project.clips.findIndex((c) => c.id === state.selection.id);
  commit(
    moveClip(
      state.project,
      state.selection.id,
      clamp(index + delta, 0, state.project.clips.length - 1),
    ),
  );
}

function kindOf(file) {
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name)) return 'image';
  if (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name))
    return 'music';
  return 'video';
}
function uploadFile(file, kind) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.upload = xhr;
    xhr.open('POST', `/api/media?kind=${kind}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Editor-Token', state.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        $('import-progress').value = e.loaded / e.total;
        $('import-name').textContent =
          e.loaded === e.total
            ? 'Reading file details…'
            : `Opening ${file.name} · ${Math.round((e.loaded / e.total) * 100)}%`;
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else
        reject(
          new Error(
            xhr.response?.error?.message || xhr.response?.error || `Import failed (${xhr.status}).`,
          ),
        );
    };
    xhr.onerror = () =>
      reject(
        new Error('The local editor could not be reached. Keep its server running and try again.'),
      );
    xhr.onabort = () => reject(new DOMException('Import cancelled.', 'AbortError'));
    xhr.send(file);
  });
}
async function importFiles(files, { relink = null } = {}) {
  if (!files?.length || busy() || !state.ready) return;
  preview.pause();
  state.importing = true;
  render();
  $('import-status').hidden = false;
  let firstVideo = null;
  try {
    for (const file of files) {
      $('import-progress').value = 0;
      $('import-name').textContent = `Opening ${file.name}…`;
      const media = await uploadFile(file, kindOf(file));
      state.media.set(media.id, media);
      state.manifest.set(media.id, media);
      if (!firstVideo && media.kind === 'video') firstVideo = media;
      if (relink !== null) {
        const next = clone(state.project);
        for (const key of ['clips', 'overlays', 'audio'])
          for (const item of next[key]) if (item.mediaId === relink) item.mediaId = media.id;
        validateProjectPartial(next, media);
        state.importing = false;
        commit(next);
        state.importing = true;
        break;
      }
      renderMedia();
    }
  } catch (e) {
    if (e.name !== 'AbortError') tell(e.message);
    else announce('Import cancelled.');
  } finally {
    state.importing = false;
    state.upload = null;
    $('import-status').hidden = true;
    if (firstVideo && !state.project.clips.length && relink === null)
      guard(() => addMedia('clip', firstVideo));
    render();
    if (relink !== null) {
      renderRelink();
      if (!missing().length) $('relink-dialog').close();
    }
  }
}
function validateProjectPartial(project, media) {
  const ids = new Set(
    allItems()
      .filter((i) => i.mediaId === state.relinkId)
      .map((i) => i.id),
  );
  for (const item of project.clips)
    if (ids.has(item.id) && (media.kind !== 'video' || item.out > media.duration + 1e-7))
      throw new Error('Choose the original video, with enough duration to keep these cuts.');
  for (const item of project.overlays)
    if (
      ids.has(item.id) &&
      (!['image', 'video'].includes(media.kind) ||
        (media.kind === 'video' &&
          (item.in + item.duration > media.duration + 1 / project.fps ||
            (item.volume > 0 && !media.hasAudio))) ||
        (media.kind === 'image' && (item.in !== 0 || item.volume !== 0)))
    )
      throw new Error('This file cannot supply the existing overlay. Choose its original source.');
  for (const item of project.audio)
    if (
      ids.has(item.id) &&
      (!['audio', 'music', 'video'].includes(media.kind) ||
        (media.kind === 'video' && !media.hasAudio) ||
        item.in >= media.duration)
    )
      throw new Error(
        'Choose an audio source with enough duration to preserve this layer’s source offset.',
      );
}
function installDrop(target) {
  let depth = 0;
  target.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    depth++;
    target.classList.add('dragging');
  });
  target.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  target.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      target.classList.remove('dragging');
    }
  });
  target.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    depth = 0;
    target.classList.remove('dragging');
    void importFiles([...e.dataTransfer.files]);
  });
}
installDrop(document.querySelector('.media-panel'));
installDrop(document.querySelector('.preview-panel'));
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});

async function openProjects() {
  if (busy()) return;
  preview.pause();
  if (!(await saveNow())) return;
  $('project-list').textContent = 'Loading saved projects…';
  $('projects-dialog').showModal();
  const data = await api('/api/projects');
  $('project-list').replaceChildren();
  if (!data.projects.length) $('project-list').append(node('p', 'muted', 'No saved projects yet.'));
  for (const saved of [...data.projects].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  )) {
    const b = button(
      '',
      async () => {
        const result = await api(`/api/projects/${encodeURIComponent(saved.id)}`);
        loadProject(result.project);
        $('projects-dialog').close();
      },
      'project-row',
    );
    b.append(
      node('span', '', saved.title || 'Untitled project'),
      node('small', '', new Date(saved.updatedAt).toLocaleString()),
    );
    $('project-list').append(b);
  }
}
function loadProject(project, manifest = []) {
  preview.pause();
  state.project = normalizeProject(project);
  state.history = [];
  state.future = [];
  state.selection = null;
  state.revision++;
  for (const item of manifest)
    if (item?.id && typeof item.name === 'string') state.manifest.set(item.id, item);
  render();
  preview.seek(0);
  scheduleSave();
  markOldExport();
  if (missing().length)
    tell('This project has missing source files. Relink them to preview and export.');
}
function downloadProject() {
  const refs = new Set(allItems().map((i) => i.mediaId));
  const media = [...refs]
    .map((id) => state.media.get(id) || state.manifest.get(id) || { id, name: 'Missing media' })
    .map(({ url, ...rest }) => rest);
  const blob = new Blob([JSON.stringify({ project: state.project, media }, null, 2)], {
      type: 'application/json',
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = `${state.project.title.replace(/[^\w .-]/g, '_') || 'project'}.localcut.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  void saveNow();
}
async function openProjectFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 ** 2) throw new Error('This project file is too large.');
  const value = JSON.parse(await file.text());
  normalizeProject(value.project || value);
  if (!(await saveNow())) return;
  loadProject(value.project || value, Array.isArray(value.media) ? value.media : []);
  $('projects-dialog').close();
}
function openRelink() {
  preview.pause();
  renderRelink();
  $('relink-dialog').showModal();
}
function renderRelink() {
  $('relink-list').replaceChildren();
  for (const id of missing()) {
    const row = node('div', 'relink-row'),
      copy = node('div');
    copy.append(
      node('strong', '', mediaName(id)),
      node(
        'small',
        '',
        `${allItems().filter((i) => i.mediaId === id).length} timeline reference(s)`,
      ),
    );
    row.append(
      copy,
      button(
        'Choose file',
        () => {
          state.relinkId = id;
          $('relink-input').click();
        },
        'button secondary',
      ),
    );
    $('relink-list').append(row);
  }
}

function openExport() {
  if (busy()) return;
  validateProject(state.project, state.media);
  preview.pause();
  $('export-name').value = state.project.title || 'my-video';
  $('export-summary').textContent =
    `${time(duration(state.project))} · ${state.project.width} × ${state.project.height} · ${state.project.fps} fps`;
  $('export-dialog').showModal();
}
function showJob(job) {
  const progress = clamp(Number(job.progress) || 0, 0, 1);
  $('export-job').hidden = false;
  $('export-progress').value = progress;
  $('job-percent').textContent = `${Math.floor(progress * 100)}%`;
  if (job.status === 'complete') {
    state.exporting = false;
    $('job-title').textContent = 'Your video is ready';
    $('job-detail').textContent = 'Download the finished MP4. Your project remains editable.';
    $('job-percent').textContent = '100%';
    $('export-progress').value = 1;
    $('download').hidden = false;
    $('download').href = job.url;
    $('download').download = job.filename || 'video.mp4';
    announce('Export complete.');
  } else if (['failed', 'cancelled'].includes(job.status)) {
    state.exporting = false;
    $('job-title').textContent =
      job.status === 'cancelled' ? 'Export cancelled' : 'Export did not finish';
    $('job-detail').textContent = job.error || 'Your project is unchanged. You can try again.';
    $('download').hidden = true;
    if (job.status === 'failed') tell(job.error || 'Export failed.');
  } else {
    $('job-title').textContent = progress > 0 ? 'Creating your video…' : 'Preparing your video…';
    $('job-detail').textContent = 'Keep the local editor running until the export finishes.';
  }
  $('export-start').hidden = state.exporting;
  $('export-start').disabled = state.loading || state.exporting;
  $('export-close').disabled = state.loading || state.exporting;
  $('export-cancel').hidden = !state.exporting;
  $('export-name').disabled = $('export-quality').disabled = state.exporting;
  render();
}
async function pollExport() {
  if (!state.exporting || !state.job) return;
  try {
    const job = await api(`/api/exports/${encodeURIComponent(state.job.id)}`);
    state.job = job;
    showJob(job);
  } catch (e) {
    if (e.status === 404)
      showJob({
        status: 'failed',
        error: 'This export is no longer available. Reload the editor and reopen your project.',
      });
    else {
      $('job-title').textContent = 'Reconnecting…';
      $('job-detail').textContent = 'Keep the editor server running. Checking again shortly.';
    }
  }
  if (state.exporting) state.poll = setTimeout(pollExport, 750);
}
async function startExport() {
  if (busy()) return;
  validateProject(state.project, state.media);
  state.loading = true;
  $('export-start').disabled = true;
  $('export-close').disabled = true;
  preview.pause();
  render();
  if (!(await saveNow())) {
    state.loading = false;
    $('export-start').disabled = false;
    $('export-close').disabled = false;
    render();
    return;
  }
  state.loading = false;
  state.exporting = true;
  state.job = null;
  $('download').hidden = true;
  $('export-cancel').disabled = true;
  showJob({ status: 'running', progress: 0 });
  try {
    state.job = await api('/api/exports', {
      method: 'POST',
      body: JSON.stringify({
        project: state.project,
        quality: $('export-quality').value,
        filename: $('export-name').value.trim() || 'video',
      }),
    });
    $('export-cancel').disabled = false;
    showJob(state.job);
    if (state.exporting) state.poll = setTimeout(pollExport, 300);
  } catch (e) {
    showJob({ status: 'failed', progress: 0, error: e.message });
  }
}
async function cancelExport() {
  if (!state.exporting || !state.job) return;
  $('export-cancel').disabled = true;
  try {
    await api(`/api/exports/${state.job.id}`, { method: 'DELETE' });
    clearTimeout(state.poll);
    await pollExport();
  } finally {
    $('export-cancel').disabled = false;
  }
}

$('import-media').onclick = () => $('media-input').click();
$('media-input').onchange = (e) => {
  void importFiles([...e.target.files]);
  e.target.value = '';
};
$('import-cancel').onclick = () => state.upload?.abort();
$('message-close').onclick = () => ($('message').hidden = true);
$('project-title').onchange = () =>
  guard(() => mutate((p) => (p.title = $('project-title').value.trim() || 'Untitled project')));
$('project-settings').onclick = () => select(null);
$('undo').onclick = undo;
$('redo').onclick = redo;
$('split').onclick = () => guard(split);
$('delete').onclick = () => guard(deleteSelected);
$('duplicate').onclick = () => guard(duplicateSelected);
$('move-left').onclick = () => guard(() => moveSelected(-1));
$('move-right').onclick = () => guard(() => moveSelected(1));
$('play').onclick = () =>
  guard(() => {
    if (state.playing) preview.pause();
    else {
      validateProject(state.project, state.media);
      preview.play();
    }
  });
$('frame-back').onclick = () => preview.frame(-1);
$('frame-forward').onclick = () => preview.frame(1);
$('playhead-time').onchange = () => {
  const t = parseTime($('playhead-time').value);
  if (Number.isFinite(t)) {
    preview.pause();
    preview.seek(t);
  } else {
    $('playhead-time').value = time(state.time);
    tell('Enter a valid time such as 00:12.500.');
  }
};
$('ruler').addEventListener('pointerdown', (e) => {
  if (busy() || e.button !== 0) return;
  e.preventDefault();
  preview.pause();
  const ruler = $('ruler');
  ruler.setPointerCapture(e.pointerId);
  let ended = false;
  const seek = (event) => {
    if (!(event.buttons & 1)) {
      end();
      return;
    }
    const rect = ruler.getBoundingClientRect();
    preview.seek((event.clientX - rect.left) / state.zoom);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener('pointermove', seek);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', end);
    ruler.removeEventListener('lostpointercapture', end);
    if (ruler.hasPointerCapture(e.pointerId)) ruler.releasePointerCapture(e.pointerId);
  };
  seek(e);
  ruler.addEventListener('lostpointercapture', end);
  window.addEventListener('pointermove', seek);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', end);
});
$('ruler').addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    preview.pause();
    preview.seek(
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? timelineDuration(state.project)
          : state.time + (e.key === 'ArrowLeft' ? -1 : 1) / state.project.fps,
    );
  }
});
$('timeline-zoom').oninput = () => {
  state.zoom = Number($('timeline-zoom').value);
  renderTimeline();
};
$('zoom-fit').onclick = () => {
  state.zoom = clamp(
    ($('timeline-scroll').clientWidth - 50) / Math.max(1, timelineDuration(state.project)),
    0.1,
    200,
  );
  $('timeline-zoom').value = String(state.zoom);
  renderTimeline();
};
$('projects').onclick = () => guard(openProjects);
$('save-project').onclick = downloadProject;
$('new-project').onclick = async () => {
  if (!(await saveNow())) return;
  loadProject(createProject({ fps: 30 }));
  $('projects-dialog').close();
};
$('load-json').onclick = () => $('project-input').click();
$('project-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  guard(() => openProjectFile(file));
};
$('relink-open').onclick = openRelink;
$('relink-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  void importFiles(file ? [file] : [], { relink: state.relinkId });
};
$('export-open').onclick = () => guard(openExport);
$('export-start').onclick = () => guard(startExport);
$('export-cancel').onclick = () => guard(cancelExport);
for (const b of document.querySelectorAll('[data-close]'))
  b.onclick = () => $(b.dataset.close).close();
$('export-dialog').addEventListener('cancel', (event) => {
  if (state.exporting || state.loading) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) preview.pause();
});
window.addEventListener('beforeunload', (event) => {
  if (state.importing || state.exporting || state.revision !== state.savedRevision) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('keydown', (e) => {
  if (
    e.repeat ||
    e.target.closest('input,textarea,select,[contenteditable="true"]') ||
    document.querySelector('dialog[open]') ||
    busy()
  )
    return;
  const modifier = e.ctrlKey || e.metaKey;
  if (modifier && e.code === 'KeyZ') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (modifier && e.code === 'KeyS') {
    e.preventDefault();
    downloadProject();
    return;
  }
  if (modifier || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    guard(split);
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    e.preventDefault();
    guard(deleteSelected);
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    if (state.project.clips.length) preview.frame(e.code === 'ArrowLeft' ? -1 : 1);
  }
});
async function boot() {
  try {
    const status = await api('/api/status');
    if (!status.token) throw new Error('The editor is not ready.');
    state.token = status.token;
    const library = await api('/api/media');
    for (const media of library.media) {
      state.media.set(media.id, media);
      state.manifest.set(media.id, media);
    }
    state.ready = true;
    let previous;
    try {
      previous = localStorage.getItem('local-cut.last-project');
    } catch {}
    if (previous)
      try {
        const saved = await api(`/api/projects/${encodeURIComponent(previous)}`);
        state.project = normalizeProject(saved.project);
      } catch {}
    $('save-state').textContent = 'Saved on this computer';
    render();
    if (!previous) scheduleSave();
  } catch (e) {
    $('save-state').textContent = 'Editor offline';
    tell(`${e.message} Start the local studio server and reload this page.`);
    render();
  }
}
Object.defineProperty(window, '__LOCAL_CUT__', {
  value: Object.freeze({
    snapshot: () =>
      structuredClone({
        project: state.project,
        selection: state.selection,
        time: state.time,
        playing: state.playing,
        importing: state.importing,
        exporting: state.exporting,
        missing: missing(),
        media: [...state.media.values()],
        preview: preview.snapshot(),
      }),
  }),
  writable: false,
});
render();
void boot();
