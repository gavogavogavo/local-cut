import { clipAt, timelineDuration } from './model.js';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
/** Preview clock and compositor. Source offsets, main cut boundaries and output
 * frame counts come from the shared model; this never modifies the project. */
export class StudioPreview {
  constructor({
    canvas,
    surface,
    stage,
    box,
    label,
    resizeHandle,
    onTime,
    onSelect,
    onTransform,
    onError,
  }) {
    Object.assign(this, {
      canvas,
      surface,
      stage,
      box,
      label,
      onTime,
      onSelect,
      onTransform,
      onError,
    });
    this.context = canvas.getContext('2d', { alpha: false });
    this.project = null;
    this.library = new Map();
    this.elements = new Map();
    this.images = new Map();
    this.time = 0;
    this.playing = false;
    this.selection = null;
    this.dirty = true;
    this.disposed = false;
    this.observer = new ResizeObserver(() => {
      this.resize();
      this.dirty = true;
    });
    this.observer.observe(stage);
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.project) return;
      const r = surface.getBoundingClientRect(),
        x = (e.clientX - r.left) / r.width,
        y = (e.clientY - r.top) / r.height;
      for (const layer of [...this.project.overlays].reverse())
        if (
          this.time >= layer.start &&
          this.time < layer.start + layer.duration &&
          x >= layer.x &&
          x <= layer.x + layer.width &&
          y >= layer.y &&
          y <= layer.y + layer.height
        ) {
          onSelect({ kind: 'overlay', id: layer.id });
          return;
        }
      const current = clipAt(
        this.project,
        Math.min(this.time, Math.max(0, timelineDuration(this.project) - 1 / this.project.fps)),
      );
      onSelect(current ? { kind: 'clip', id: current.clip.id } : null);
    });
    const begin = (event, resizing) => {
      if (!this.selection || this.selection.kind !== 'overlay' || event.button !== 0) return;
      const layer = this.project.overlays.find((l) => l.id === this.selection.id);
      if (!layer) return;
      event.preventDefault();
      event.stopPropagation();
      this.pause();
      const original = { ...layer },
        rect = surface.getBoundingClientRect(),
        x = event.clientX,
        y = event.clientY;
      onTransform(original, 'start');
      let ended = false;
      box.setPointerCapture(event.pointerId);
      const move = (e) => {
        if (!(e.buttons & 1)) {
          end();
          return;
        }
        const dx = (e.clientX - x) / rect.width,
          dy = (e.clientY - y) / rect.height;
        const patch = resizing
          ? {
              ...original,
              width: clamp(original.width + dx, 0.01, 2),
              height: clamp(original.height + dy, 0.01, 2),
            }
          : { ...original, x: clamp(original.x + dx, -1, 1), y: clamp(original.y + dy, -1, 1) };
        onTransform(patch, 'update');
      };
      const end = () => {
        if (ended) return;
        ended = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        box.removeEventListener('lostpointercapture', end);
        if (box.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
        onTransform(null, 'end');
      };
      box.addEventListener('lostpointercapture', end);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
    };
    box.addEventListener('pointerdown', (e) => begin(e, false));
    resizeHandle.addEventListener('pointerdown', (e) => begin(e, true));
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }
  setProject(project, library) {
    this.project = project;
    this.library = library;
    this.time = Math.min(this.time, timelineDuration(project));
    this.dirty = true;
    this.resize();
    const ids = new Set([...project.clips, ...project.overlays, ...project.audio].map((i) => i.id));
    for (const [id, entry] of this.elements) {
      const source = library.get(entry.mediaId)?.url;
      if (!ids.has(id) || !source || new URL(source, location.href).href !== entry.element.src)
        this.removeElement(id);
    }
    for (const id of this.images.keys()) if (!library.has(id)) this.images.delete(id);
    this.updateSelection();
  }
  setSelection(selection) {
    this.selection = selection;
    this.updateSelection();
  }
  resize() {
    if (!this.project) return;
    const r = this.stage.getBoundingClientRect(),
      style = getComputedStyle(this.stage),
      availableWidth = r.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      availableHeight = r.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      ratio = this.project.width / this.project.height;
    let w = Math.min(availableWidth, availableHeight * ratio);
    w = Math.max(1, w);
    const h = w / ratio;
    this.surface.style.width = `${w}px`;
    this.surface.style.height = `${h}px`;
    const pixelRatio = Math.min(devicePixelRatio || 1, 1.5),
      cw = Math.max(1, Math.round(Math.min(this.project.width, w * pixelRatio))),
      ch = Math.max(1, Math.round(cw / ratio));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.dirty = true;
  }
  seek(time) {
    if (!this.project) return;
    this.time = clamp(time, 0, timelineDuration(this.project));
    this.anchorTime = this.time;
    this.anchor = performance.now();
    this.dirty = true;
    this.render(true);
    this.onTime(this.time, this.playing);
  }
  play() {
    if (!this.project || !timelineDuration(this.project)) return;
    if (this.time >= timelineDuration(this.project) - 0.0001) this.time = 0;
    this.playing = true;
    this.anchor = performance.now();
    this.anchorTime = this.time;
    for (const entry of this.elements.values()) entry.failed = false;
    this.render(true);
    this.onTime(this.time, true);
  }
  pause() {
    if (this.playing && this.project)
      this.time = clamp(
        this.anchorTime + (performance.now() - this.anchor) / 1000,
        0,
        timelineDuration(this.project),
      );
    this.playing = false;
    for (const entry of this.elements.values()) entry.element.pause();
    this.dirty = true;
    this.onTime(this.time, false);
  }
  frame(direction) {
    this.pause();
    this.seek((Math.round(this.time * this.project.fps) + direction) / this.project.fps);
  }
  tick(now) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (!this.project) return;
    if (this.playing) {
      this.time = Math.min(
        timelineDuration(this.project),
        this.anchorTime + (now - this.anchor) / 1000,
      );
      if (this.time >= timelineDuration(this.project)) this.pause();
      this.onTime(this.time, this.playing);
      this.dirty = true;
    }
    if (this.dirty) {
      this.render(false);
      this.dirty = false;
    }
  }
  element(item, kind) {
    let entry = this.elements.get(item.id);
    const media = this.library.get(item.mediaId);
    if (!media) return null;
    if (entry && entry.mediaId !== item.mediaId) {
      this.removeElement(item.id);
      entry = null;
    }
    if (!entry) {
      const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
      element.preload = 'auto';
      if (kind !== 'audio') element.playsInline = true;
      element.src = new URL(media.url, location.href).href;
      element.preservesPitch = true;
      entry = {
        element,
        mediaId: media.id,
        used: performance.now(),
        failed: false,
        pending: false,
      };
      this.elements.set(item.id, entry);
      for (const name of ['loadeddata', 'seeked', 'loadedmetadata'])
        element.addEventListener(name, () => {
          this.dirty = true;
        });
      element.addEventListener('error', () => {
        if (!entry.failed) {
          entry.failed = true;
          this.onError(
            `“${media.name}” cannot be previewed in this browser. A standard MP4, PNG, JPEG, or MP3 usually works. You can still try exporting.`,
          );
        }
      });
    }
    entry.used = performance.now();
    return entry;
  }
  removeElement(id) {
    const entry = this.elements.get(id);
    if (!entry) return;
    entry.element.pause();
    entry.element.removeAttribute('src');
    entry.element.load();
    this.elements.delete(id);
  }
  synchronize(entry, target, rate, volume, active, force = false, loop = false) {
    if (!entry) return;
    const element = entry.element;
    element.playbackRate = rate;
    element.volume = clamp(volume, 0, 1);
    element.loop = loop;
    if (element.readyState >= 1 && Number.isFinite(target)) {
      const tolerance = this.playing && !force ? 0.14 : 0.002;
      if (Math.abs(element.currentTime - target) > tolerance && !element.seeking)
        try {
          element.currentTime = Math.max(0, target);
        } catch {}
    }
    if (this.playing && active && !entry.failed) {
      if (element.paused && !entry.pending) {
        entry.pending = true;
        element
          .play()
          .catch((error) => {
            if (error.name === 'AbortError' || ![...this.elements.values()].includes(entry)) return;
            entry.failed = true;
            this.onError(
              'A preview source could not play. Pause and press Play again, or try a browser-supported file.',
            );
          })
          .finally(() => (entry.pending = false));
      }
    } else element.pause();
  }
  drawFit(source, x, y, width, height, fit = 'contain', opacity = 1) {
    const sw = source.videoWidth || source.naturalWidth || source.width,
      sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;
    const c = this.context;
    c.save();
    c.globalAlpha = clamp(opacity, 0, 1);
    c.beginPath();
    c.rect(x, y, width, height);
    c.clip();
    const scale =
        fit === 'cover' ? Math.max(width / sw, height / sh) : Math.min(width / sw, height / sh),
      w = sw * scale,
      h = sh * scale;
    c.drawImage(source, x + (width - w) / 2, y + (height - h) / 2, w, h);
    c.restore();
  }
  fade(item, elapsed, audibleEnd = item.duration) {
    const fi = item.fadeIn || 0,
      fo = Math.min(item.fadeOut || 0, audibleEnd);
    return (
      (fi ? clamp(elapsed / fi, 0, 1) : 1) * (fo ? clamp((audibleEnd - elapsed) / fo, 0, 1) : 1)
    );
  }
  render(force = false) {
    if (!this.project) return;
    const p = this.project,
      c = this.context,
      w = p.width,
      h = p.height,
      total = timelineDuration(p),
      t = this.time >= total && total > 0 ? Math.max(0, total - 1 / p.fps) : this.time;
    const used = new Set();
    c.setTransform(this.canvas.width / w, 0, 0, this.canvas.height / h, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    const current = clipAt(p, t);
    if (current) {
      const entry = this.element(current.clip, 'video');
      if (entry) {
        used.add(current.clip.id);
        this.synchronize(
          entry,
          current.sourceTime,
          current.clip.speed,
          current.clip.volume,
          true,
          force,
        );
        if (entry.element.readyState >= 2 && !entry.element.seeking)
          this.drawFit(entry.element, 0, 0, w, h, current.clip.fit);
      }
      // Preload one cut ahead so normal short sequences do not wait at transitions.
      const next = p.clips[current.index + 1];
      if (next) {
        const upcoming = this.element(next, 'video');
        if (upcoming) {
          used.add(next.id);
          this.synchronize(upcoming, next.in, next.speed, 0, false, force);
        }
      }
    }
    for (const item of p.overlays) {
      if (t < item.start || t >= item.start + item.duration) continue;
      const media = this.library.get(item.mediaId);
      if (!media) continue;
      const elapsed = t - item.start,
        fade = this.fade(item, elapsed),
        x = item.x * w,
        y = item.y * h,
        width = item.width * w,
        height = item.height * h;
      if (media.kind === 'image') {
        let image = this.images.get(media.id);
        if (!image) {
          image = new Image();
          image.onload = () => (this.dirty = true);
          image.onerror = () => this.onError(`“${media.name}” could not be previewed.`);
          image.src = media.url;
          this.images.set(media.id, image);
        }
        if (image.complete && image.naturalWidth)
          this.drawFit(image, x, y, width, height, 'contain', item.opacity * fade);
      } else {
        const entry = this.element(item, 'video');
        if (!entry) continue;
        used.add(item.id);
        this.synchronize(entry, item.in + elapsed, 1, item.volume * fade, true, force);
        if (entry.element.readyState >= 2 && !entry.element.seeking)
          this.drawFit(entry.element, x, y, width, height, 'contain', item.opacity * fade);
      }
    }
    for (const item of p.audio) {
      if (t < item.start || t >= item.start + item.duration) continue;
      const media = this.library.get(item.mediaId);
      if (!media || !(media.duration > 0)) continue;
      const elapsed = t - item.start,
        sourceTime = item.in + elapsed,
        audibleEnd = item.loop
          ? item.duration
          : Math.min(item.duration, Math.max(0, media.duration - item.in));
      if (!item.loop && sourceTime >= media.duration) continue;
      const entry = this.element(item, 'audio');
      if (!entry) continue;
      used.add(item.id);
      this.synchronize(
        entry,
        item.loop ? sourceTime % media.duration : sourceTime,
        1,
        item.volume * this.fade(item, elapsed, audibleEnd),
        true,
        force,
        item.loop,
      );
    }
    for (const [id, entry] of this.elements) {
      if (!used.has(id)) {
        entry.element.pause();
        if (this.elements.size > 12 && performance.now() - entry.used > 2000)
          this.removeElement(id);
      }
    }
    this.updateSelection();
  }
  updateSelection() {
    const item =
      this.selection?.kind === 'overlay'
        ? this.project?.overlays.find((l) => l.id === this.selection.id)
        : null;
    if (!item || this.time < item.start || this.time >= item.start + item.duration) {
      this.box.hidden = true;
      return;
    }
    this.box.hidden = false;
    Object.assign(this.box.style, {
      left: `${item.x * 100}%`,
      top: `${item.y * 100}%`,
      width: `${item.width * 100}%`,
      height: `${item.height * 100}%`,
    });
    this.label.textContent = this.library.get(item.mediaId)?.name || 'Missing media';
  }
  snapshot() {
    return {
      time: this.time,
      playing: this.playing,
      elements: [...this.elements].map(([id, e]) => ({
        id,
        mediaId: e.mediaId,
        time: e.element.currentTime,
        paused: e.element.paused,
        rate: e.element.playbackRate,
        volume: e.element.volume,
        ready: e.element.readyState,
        seeking: e.element.seeking,
      })),
      images: this.images.size,
    };
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    for (const id of [...this.elements.keys()]) this.removeElement(id);
    this.images.clear();
  }
}
