import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const require = createRequire(import.meta.url);
export const ffmpegPath: string = process.env.FFMPEG_BIN || require('ffmpeg-static');
export const ffprobePath: string = process.env.FFPROBE_BIN || require('ffprobe-static').path;
export const formats =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mp3,wav,flac,ogg,aac,png_pipe,jpeg_pipe';
export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  videoStreamIndex?: number;
  audioStreamIndex?: number;
  hdr: boolean;
}
export interface Media extends MediaInfo {
  id: string;
  name: string;
  kind: 'video' | 'music' | 'image';
  path: string;
  url: string;
  size: number;
}
export interface Edit {
  videoId: string;
  musicId: string | null;
  start: number;
  end: number;
  videoVolume: number;
  musicVolume: number;
  musicOffset: number;
  fadeIn: number;
  fadeOut: number;
  loopMusic: boolean;
  quality: 'high' | 'compact';
  filename: string;
}
export class EditorError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Restrict probing to ordinary local media formats; never accept playlists/network sources. */
export async function probeMedia(
  path: string,
  kind: 'video' | 'music' | 'image',
  signal?: AbortSignal,
): Promise<MediaInfo> {
  if (signal?.aborted) throw new EditorError('Import cancelled.', 499);
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        formats,
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        path,
      ],
      { windowsHide: true },
    );
    let stdout = '',
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill();
    };
    const cancel = () => stop(new EditorError('Import cancelled.', 499));
    const timeout = setTimeout(
      () =>
        stop(
          new EditorError(
            'This file took too long to inspect. Try a standard MP4, MP3 or WAV file.',
          ),
        ),
      60000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000)
        stop(new EditorError('This media file has too much metadata.'));
    });
    child.stderr.resume();
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    // Wait for process exit before callers remove its file (important on Windows).
    child.once('close', (code) => {
      cleanup();
      failure
        ? reject(failure)
        : code === 0
          ? resolve(stdout)
          : reject(
              new EditorError(
                'Could not read this media file. Use MP4 video, MP3/WAV audio, or a PNG/JPEG image.',
              ),
            );
    });
  });
  const data = JSON.parse(raw),
    streams = data.streams ?? [];
  const video = streams.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s: any) => s.codec_type === 'audio');
  if (kind !== 'music' && !video)
    throw new EditorError(
      'This file has no usable picture. Choose a video recording or PNG/JPEG image.',
    );
  if (kind === 'music' && !audio)
    throw new EditorError('This file has no audio track. Choose a music or sound file.');
  if (kind === 'image' && !['png', 'mjpeg'].includes(video?.codec_name))
    throw new EditorError('Use a still PNG or JPEG image.');
  const selected = kind !== 'music' ? video : audio;
  const duration = kind === 'image' ? 0 : Number(selected?.duration ?? data.format?.duration);
  if (kind !== 'image' && (!Number.isFinite(duration) || duration <= 0 || duration > 86400))
    throw new EditorError('This editor needs a finite recording shorter than 24 hours.');
  if (video && (video.width > 8192 || video.height > 8192 || video.width * video.height > 33554432))
    throw new EditorError(
      'This picture is too large. Use media up to 8192 pixels on either side and 32 megapixels.',
    );
  const [n, d] = (video?.avg_frame_rate ?? '0/1').split('/').map(Number);
  const hdr = ['smpte2084', 'arib-std-b67'].includes(video?.color_transfer);
  if (kind === 'video' && hdr)
    throw new EditorError(
      'This recording uses HDR. Export or record an SDR copy first so the colours stay correct.',
    );
  const rotated = video?.side_data_list?.some(
    (s: any) => Math.abs(Number(s.rotation)) % 180 === 90,
  );
  return {
    duration,
    width: (rotated ? video?.height : video?.width) ?? 0,
    height: (rotated ? video?.width : video?.height) ?? 0,
    fps: d ? n / d : 0,
    hasAudio: !!audio,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    videoStreamIndex: video?.index,
    audioStreamIndex: audio?.index,
    hdr,
  };
}

export function validateEdit(value: unknown, media: Map<string, Media>): Edit {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EditorError('Invalid export settings.');
  const p = value as Record<string, unknown>;
  const video = media.get(String(p.videoId));
  if (!video || video.kind !== 'video')
    throw new EditorError('The video is no longer available. Choose it again.');
  const musicId = p.musicId == null ? null : String(p.musicId),
    music = musicId ? media.get(musicId) : null;
  if (musicId && (!music || music.kind !== 'music'))
    throw new EditorError('The music is no longer available. Choose it again.');
  const num = (key: string, min: number, max: number, fallback?: number) => {
    const value = p[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      throw new EditorError(`Invalid ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}.`);
    return value;
  };
  const start = num('start', 0, video.duration),
    end = Math.min(video.duration, num('end', 0, video.duration + 0.02));
  // A handle at (end - .05) can subtract back to .0499999999999998.
  if (end - start < 0.05 - 1e-8)
    throw new EditorError('Keep at least 0.05 seconds, with the end after the start.');
  const quality = p.quality ?? 'high';
  if (quality !== 'high' && quality !== 'compact') throw new EditorError('Unknown export quality.');
  if (p.loopMusic !== undefined && typeof p.loopMusic !== 'boolean')
    throw new EditorError('Invalid music loop setting.');
  const filename =
    (typeof p.filename === 'string' ? p.filename : 'surf-clip')
      .replace(/\.mp4$/i, '')
      .replace(/[^a-zA-Z0-9 _.-]/g, '')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 90) || 'surf-clip';
  return {
    videoId: video.id,
    musicId,
    start,
    end,
    videoVolume: num('videoVolume', 0, 1, 1),
    musicVolume: num('musicVolume', 0, 1, 0.25),
    musicOffset: num('musicOffset', 0, music ? Math.max(0, music.duration - 0.001) : 0, 0),
    fadeIn: num('fadeIn', 0, Math.min(10, end - start), 0),
    fadeOut: num('fadeOut', 0, Math.min(10, end - start), 0),
    loopMusic: p.loopMusic !== false,
    quality,
    filename: `${filename}.mp4`,
  };
}

/** Accurate re-encoding cuts between keyframes. The source file is never overwritten. */
export function exportArguments(
  edit: Edit,
  video: Media,
  music: Media | null,
  output: string,
): string[] {
  const duration = edit.end - edit.start;
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-y',
    '-threads',
    '4',
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    formats,
    '-ss',
    String(edit.start),
    '-i',
    video.path,
  ];
  if (music) {
    if (edit.loopMusic) args.push('-stream_loop', '-1');
    args.push('-protocol_whitelist', 'file,pipe', '-format_whitelist', formats, '-i', music.path);
  }
  const filters: string[] = [],
    audio: string[] = [];
  if (video.hasAudio && edit.videoVolume > 0) {
    // Input seek rebases timestamps together. Keep the original A/V offset and
    // pad a delayed audio start, rather than sliding that audio to video time 0.
    filters.push(
      `[0:${video.audioStreamIndex ?? 'a:0'}]aresample=48000:async=1:first_pts=0,volume=${edit.videoVolume},apad,atrim=duration=${duration}[original]`,
    );
    audio.push('[original]');
  }
  if (music && edit.musicVolume > 0) {
    // Trim after looping: offset starts within the song, subsequent loops play the whole song.
    const chain = [
      `atrim=start=${edit.musicOffset}:end=${edit.musicOffset + duration}`,
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      `volume=${edit.musicVolume}`,
      'apad',
      `atrim=duration=${duration}`,
    ];
    if (edit.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${edit.fadeIn}`);
    const audibleDuration = edit.loopMusic
        ? duration
        : Math.min(duration, music.duration - edit.musicOffset),
      fadeOut = Math.min(edit.fadeOut, audibleDuration);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${audibleDuration - fadeOut}:d=${fadeOut}`);
    filters.push(`[1:${music.audioStreamIndex ?? 'a:0'}]${chain.join(',')}[music]`);
    audio.push('[music]');
  }
  if (audio.length) {
    filters.push(
      `${audio.join('')}${audio.length > 1 ? `amix=inputs=${audio.length}:duration=longest:normalize=0,` : ''}alimiter=limit=0.95:level=false:latency=true[outaudio]`,
    );
    args.push('-filter_complex_threads', '2', '-filter_complex', filters.join(';'));
  }
  args.push('-map', `0:${video.videoStreamIndex ?? 'v:0'}`);
  if (audio.length)
    args.push('-map', '[outaudio]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push(
    '-t',
    String(duration),
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    edit.quality === 'high' ? '18' : '23',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '4',
    '-fps_mode',
    'vfr',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  );
  return args;
}
export function spawnExport(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(ffmpegPath, args, { windowsHide: true });
}
