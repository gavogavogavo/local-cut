import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { ffmpegPath, formats, EditorError, type Media } from './media';
import { duration, clipFrames, type Project } from './studio/model.js';

type Progress = (progress: number, stage: string) => void;
const n = (value: number) => String(Number(value.toFixed(9)));
const tempo = (speed: number) => {
  const values: number[] = [];
  while (speed > 2) {
    values.push(2);
    speed /= 2;
  }
  while (speed < 0.5) {
    values.push(0.5);
    speed /= 0.5;
  }
  values.push(speed);
  return values.map((v) => `atempo=${n(v)}`).join(',');
};
const baseArgs = () => ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
const sourceArgs = (media: Media, at = 0) => [
  '-threads',
  '2',
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  formats,
  '-ss',
  n(at),
  '-i',
  media.path,
];

/** FFmpeg keeps layer inputs open together. Bound aggregate picture work,
 * including non-overlapping layers, before launching any native process. */
export function validateRenderBudget(project: Project, media: Map<string, Media>) {
  let pixels = 2 * project.width * project.height;
  for (const layer of project.overlays) {
    if (layer.opacity <= 0 || layer.start >= duration(project)) continue;
    const source = media.get(layer.mediaId)!;
    pixels +=
      source.width * source.height +
      Math.round(layer.width * project.width) * Math.round(layer.height * project.height);
  }
  if (pixels > 48_000_000)
    throw new EditorError(
      'This layer stack is too heavy for one export. Reduce the canvas resolution, layer sizes, or number of picture layers.',
    );
}

async function run(
  args: string[],
  seconds: number,
  signal: AbortSignal,
  progress: (fraction: number) => void,
) {
  if (signal.aborted) throw new EditorError('Export cancelled.', 499);
  await new Promise<void>((done, reject) => {
    const child = spawn(ffmpegPath, [...baseArgs(), ...args, '-progress', 'pipe:1', '-nostats'], {
      windowsHide: true,
    });
    let stderr = '',
      buffer = '',
      settled = false;
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, value] = line.trim().split('=');
        if (key === 'out_time_us') {
          const fraction = Number(value) / 1e6 / seconds;
          if (Number.isFinite(fraction)) progress(Math.max(0, Math.min(1, fraction)));
        }
      }
    });
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-5000)));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      error ? reject(error) : done();
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code) =>
      finish(
        signal.aborted
          ? new EditorError('Export cancelled.', 499)
          : code === 0
            ? undefined
            : new Error(`FFmpeg export failed: ${stderr}`),
      ),
    );
  });
}

/** Main clips are decoded one at a time, with PCM audio so cuts have no AAC priming gaps.
 * H.264/PCM MOV masters preserve exact frame timestamps; Matroska rounds to milliseconds.
 * Layers are composited in the final pass. */
export async function renderComposition(
  project: Project,
  media: Map<string, Media>,
  output: string,
  options: { signal: AbortSignal; onProgress: Progress; quality: 'high' | 'compact' },
) {
  const { signal, onProgress, quality } = options,
    total = duration(project),
    fps = project.fps;
  validateRenderBudget(project, media);
  const work = await mkdtemp(join(dirname(output), '.render-'));
  try {
    const overlays = project.overlays.filter(
      (layer) => layer.start < total && layer.duration > 0 && layer.opacity > 0,
    );
    const hasLayers = overlays.length > 0;
    let elapsed = 0;
    const files: string[] = [];
    for (let i = 0; i < project.clips.length; i++) {
      if (signal.aborted) throw new EditorError('Export cancelled.', 499);
      const clip = project.clips[i],
        source = media.get(clip.mediaId)!,
        frames = clipFrames(project, clip),
        length = frames / fps,
        samples = Math.round(length * 48000),
        segment = join(work, `clip-${i}.mov`);
      const resize =
        clip.fit === 'cover'
          ? `scale=${project.width}:${project.height}:force_original_aspect_ratio=increase,crop=${project.width}:${project.height}`
          : `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
      const vf = `[0:${source.videoStreamIndex ?? 'v:0'}]trim=duration=${n(clip.out - clip.in)},setpts=(PTS-STARTPTS)/${n(clip.speed)},fps=${fps},${resize},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=N/(${fps}*TB)[v]`;
      const af =
        source.hasAudio && clip.volume > 0
          ? `[0:${source.audioStreamIndex ?? 'a:0'}]aresample=48000:async=1:first_pts=0,atrim=duration=${n(clip.out - clip.in)},${tempo(clip.speed)},volume=${n(clip.volume)},aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a]`
          : `anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[a]`;
      const crf = quality === 'high' ? (hasLayers ? '14' : '18') : hasLayers ? '20' : '23';
      await run(
        [
          ...sourceArgs(source, clip.in),
          '-filter_complex_threads',
          '2',
          '-filter_complex',
          `${vf};${af}`,
          '-map',
          '[v]',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          crf,
          '-threads',
          '4',
          '-c:a',
          'pcm_s16le',
          '-video_track_timescale',
          String(fps),
          '-t',
          n(length),
          '-map_metadata',
          '-1',
          segment,
        ],
        length,
        signal,
        (p) =>
          onProgress(
            (0.6 * (elapsed + p * length)) / total,
            `Rendering clip ${i + 1} of ${project.clips.length}`,
          ),
      );
      files.push(`file 'clip-${i}.mov'\nduration ${n(length)}`);
      elapsed += length;
    }
    const list = join(work, 'clips.ffconcat');
    await writeFile(list, `ffconcat version 1.0\n${files.join('\n')}\n`);
    const args = [
      '-threads',
      '2',
      '-f',
      'concat',
      '-safe',
      '1',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      list,
    ];
    const filters: string[] = [],
      audio = ['[baseaudio]'];
    let input = 1,
      currentVideo = '0:v:0';
    filters.push(
      `[0:a:0]aresample=48000:async=1:first_pts=0,apad,atrim=duration=${n(total)}[baseaudio]`,
    );
    const addSound = (
      index: number,
      source: Media,
      item: {
        in: number;
        start: number;
        duration: number;
        volume: number;
        fadeIn: number;
        fadeOut: number;
      },
      label: string,
      loop = false,
      inputSeek = false,
    ) => {
      if (!source.hasAudio || item.volume <= 0) return;
      const length = Math.min(item.duration, total - item.start),
        available = loop
          ? item.duration
          : Math.min(item.duration, Math.max(0, source.duration - item.in));
      const fadeIn = item.fadeIn,
        fadeOut = Math.min(item.fadeOut, available);
      const chain = ['aresample=48000:async=1:first_pts=0'];
      if (!inputSeek)
        chain.push(`atrim=start=${n(item.in)}:end=${n(item.in + length)}`, 'asetpts=PTS-STARTPTS');
      else chain.push(`atrim=duration=${n(length)}`);
      chain.push(
        `volume=${n(item.volume)}`,
        'aformat=sample_rates=48000:channel_layouts=stereo',
        'apad',
        `atrim=duration=${n(length)}`,
      );
      if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${n(fadeIn)}`);
      if (fadeOut > 0) chain.push(`afade=t=out:st=${n(available - fadeOut)}:d=${n(fadeOut)}`);
      chain.push(`adelay=${Math.round(item.start * 48000)}S:all=1`);
      filters.push(`[${index}:${source.audioStreamIndex ?? 'a:0'}]${chain.join(',')}[${label}]`);
      audio.push(`[${label}]`);
    };
    // Keep audio even when an overlay is fully transparent: visibility and sound are separate controls.
    const visualIds = new Set(overlays.map((layer) => layer.id));
    for (const layer of project.overlays.filter(
      (layer) => layer.start < total && (visualIds.has(layer.id) || layer.volume > 0),
    )) {
      const source = media.get(layer.mediaId)!,
        index = input++,
        length = Math.min(layer.duration, total - layer.start);
      if (source.kind === 'image')
        args.push(
          '-threads',
          '1',
          '-f',
          'image2',
          '-pattern_type',
          'none',
          '-loop',
          '1',
          '-framerate',
          String(fps),
          '-c:v',
          source.videoCodec ?? 'png',
          '-i',
          source.path,
        );
      else args.push(...sourceArgs(source, layer.in));
      if (visualIds.has(layer.id)) {
        const w = Math.max(2, Math.round(layer.width * project.width)),
          h = Math.max(2, Math.round(layer.height * project.height));
        const chain = [
          `trim=duration=${n(length)}`,
          'setpts=PTS-STARTPTS',
          `fps=${fps}`,
          'tpad=stop_mode=clone:stop_duration=1',
          `trim=duration=${n(length)}`,
          'format=rgba',
          `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
          'setsar=1',
          `colorchannelmixer=aa=${n(layer.opacity)}`,
        ];
        if (layer.fadeIn > 0)
          chain.push(`fade=t=in:st=0:d=${n(Math.min(layer.fadeIn, layer.duration))}:alpha=1`);
        if (layer.fadeOut > 0)
          chain.push(
            `fade=t=out:st=${n(Math.max(0, layer.duration - layer.fadeOut))}:d=${n(Math.min(layer.fadeOut, layer.duration))}:alpha=1`,
          );
        chain.push(`setpts=PTS+${n(layer.start)}/TB`);
        filters.push(
          `[${index}:${source.videoStreamIndex ?? 'v:0'}]${chain.join(',')}[layer${index}]`,
        );
        filters.push(
          `[${currentVideo}][layer${index}]overlay=x=${Math.round(layer.x * project.width)}:y=${Math.round(layer.y * project.height)}:eof_action=pass:repeatlast=0:enable='gte(t,${n(layer.start)})*lt(t,${n(layer.start + length)})'[video${index}]`,
        );
        currentVideo = `video${index}`;
      }
      if (source.kind === 'video')
        addSound(index, source, layer, `overlayAudio${index}`, false, true);
    }
    for (const item of project.audio.filter((item) => item.start < total && item.volume > 0)) {
      const source = media.get(item.mediaId)!,
        index = input++;
      args.push('-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats);
      if (item.loop) args.push('-stream_loop', '-1');
      args.push('-i', source.path);
      addSound(index, source, item, `music${index}`, item.loop);
    }
    filters.push(
      `${audio.join('')}${audio.length > 1 ? `amix=inputs=${audio.length}:duration=longest:normalize=0,` : ''}alimiter=limit=0.95:level=false:latency=true,apad,atrim=end_sample=${Math.round(total * 48000)}[outaudio]`,
    );
    args.push(
      '-filter_complex_threads',
      '2',
      '-filter_complex',
      filters.join(';'),
      '-map',
      hasLayers ? `[${currentVideo}]` : '0:v:0',
      '-map',
      '[outaudio]',
    );
    if (hasLayers)
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        quality === 'high' ? '18' : '23',
        '-threads',
        '4',
        '-pix_fmt',
        'yuv420p',
      );
    else args.push('-c:v', 'copy');
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      n(total),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-movflags',
      '+faststart',
      output,
    );
    await run(args, total, signal, (p) =>
      onProgress(0.6 + 0.39 * p, 'Compositing layers and mixing audio'),
    );
    onProgress(1, 'Complete');
  } finally {
    const inside = relative(resolve(dirname(output)), resolve(work));
    if (!inside.startsWith('..') && !isAbsolute(inside) && inside.startsWith('.render-'))
      await rm(work, { recursive: true, force: true });
  }
}
