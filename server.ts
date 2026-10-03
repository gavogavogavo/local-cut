import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, stat, readFile, unlink, access } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ffmpegPath,
  ffprobePath,
  probeMedia,
  validateEdit,
  exportArguments,
  spawnExport,
  EditorError,
  type Media,
  type Edit,
} from './media';
import { openStore, validId } from './store';
import { normalizeProject, validateProject, duration, type Project } from './studio/model.js';
import { renderComposition, validateRenderBudget } from './composition';

const MAX_BYTES = 8 * 1024 ** 3;
const DEFAULT_DATA = fileURLToPath(new URL('./.clip-editor/', import.meta.url));
const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const STUDIO = fileURLToPath(new URL('./studio/', import.meta.url));
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
interface Job {
  id: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  duration: number;
  filename: string;
  error?: string;
  url?: string;
  stage?: string;
  path: string;
  sourceIds: string[];
  cancel: () => void;
  done: Promise<void>;
}
const json = (res: ServerResponse, code: number, value: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const remove = async (path: string) => {
  await unlink(path).catch(() => {});
};
async function jsonBody(req: IncomingMessage) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 512000) throw new EditorError('Request too large.', 413);
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new EditorError('Expected a JSON object.');
  }
}
const publicMedia = ({ path, ...data }: Media) => data;
const publicJob = (job: Job) => ({
  id: job.id,
  status: job.status,
  progress: job.progress,
  duration: job.duration,
  filename: job.filename,
  error: job.error,
  url: job.url,
  stage: job.stage,
});

/** Local-only editor. All user media remains under storageDir; originals are never opened for writing. */
export async function startEditorServer(
  options: { port?: number; host?: '127.0.0.1'; storageDir?: string; legacyUi?: boolean } = {},
) {
  const root = resolve(options.storageDir ?? DEFAULT_DATA),
    uploads = join(root, 'imports'),
    exportsDir = join(root, 'exports');
  await Promise.all([
    mkdir(uploads, { recursive: true }),
    mkdir(exportsDir, { recursive: true }),
    access(ffmpegPath),
    access(ffprobePath),
  ]);
  const store = await openStore(root),
    media = store.media,
    jobs = new Map<string, Job>();
  const token = randomBytes(32).toString('hex');
  let active: Job | null = null,
    uploading = false,
    closing = false;
  let activeImport: { controller: AbortController; done: Promise<void> } | null = null;
  async function sendFile(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    type: string,
    download?: string,
  ) {
    const { size } = await stat(path);
    let start = 0,
      end = size - 1,
      status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
    }
    const headers: Record<string, string | number> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(createReadStream(path, { start, end }), res).catch(() => {});
  }
  function newJob(edit: Edit): Job {
    const id = randomUUID(),
      path = join(exportsDir, `${id}.mp4`),
      video = media.get(edit.videoId)!,
      music = edit.musicId ? media.get(edit.musicId)! : null;
    const child = spawnExport(exportArguments(edit, video, music, path));
    let finish!: () => void,
      stderr = '',
      progressBuffer = '';
    const done = new Promise<void>((r) => {
      finish = r;
    });
    const job: Job = {
      id,
      status: 'running',
      progress: 0,
      duration: edit.end - edit.start,
      filename: edit.filename,
      path,
      sourceIds: [edit.videoId, ...(edit.musicId ? [edit.musicId] : [])],
      done,
      cancel: () => {
        if (job.status === 'running') {
          job.status = 'cancelled';
          child.kill();
        }
      },
    };
    jobs.set(id, job);
    active = job;
    child.stdout.on('data', (chunk) => {
      progressBuffer += chunk;
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, value] = line.trim().split('=');
        if (key === 'out_time_us' && job.status === 'running') {
          const seconds = Number(value) / 1e6;
          if (Number.isFinite(seconds))
            job.progress = Math.max(job.progress, Math.min(0.99, seconds / job.duration));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-6000);
    });
    child.once('error', () => {
      job.status = 'failed';
      job.error = 'The export tool could not start. Restart the editor and try again.';
    });
    child.once('close', async (code) => {
      if (job.status === 'running') {
        if (code === 0) {
          job.status = 'complete';
          job.progress = 1;
          job.url = `/api/exports/${id}/file`;
        } else {
          job.status = 'failed';
          job.error = 'Export failed. Check free disk space and try a standard SDR MP4 recording.';
          console.error(`Editor export ${id}: ${stderr}`);
        }
      }
      if (job.status !== 'complete') await remove(path);
      if (active === job) active = null;
      finish();
    });
    return job;
  }
  function newTimelineJob(project: Project, quality: 'high' | 'compact', filename: string): Job {
    const id = randomUUID(),
      path = join(exportsDir, `${id}.mp4`),
      controller = new AbortController();
    let finished!: () => void;
    const done = new Promise<void>((r) => (finished = r));
    const job: Job = {
      id,
      status: 'running',
      progress: 0,
      duration: duration(project),
      filename,
      path,
      sourceIds: [...project.clips, ...project.overlays, ...project.audio].map(
        (item) => item.mediaId,
      ),
      done,
      cancel: () => {
        if (job.status === 'running') {
          job.status = 'cancelled';
          controller.abort();
        }
      },
    };
    jobs.set(id, job);
    active = job;
    void renderComposition(project, media, path, {
      signal: controller.signal,
      quality,
      onProgress: (progress, stage) => {
        if (job.status === 'running') {
          job.progress = Math.max(job.progress, Math.min(0.99, progress));
          job.stage = stage;
        }
      },
    })
      .then(() => {
        if (job.status === 'running') {
          job.status = 'complete';
          job.progress = 1;
          job.url = `/api/exports/${id}/file`;
        }
      })
      .catch((error) => {
        if (job.status === 'running') {
          job.status = 'failed';
          job.error = 'Export failed. Check disk space and your source files, then try again.';
          console.error(`Editor composition ${id}:`, String(error));
        }
      })
      .finally(async () => {
        if (job.status !== 'complete') await remove(path);
        if (active === job) active = null;
        finished();
      });
    return job;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const port = (server.address() as any)?.port;
      const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
      if (!hosts.includes(req.headers.host ?? ''))
        throw new EditorError('Only local requests are accepted.', 403);
      const origin = req.headers.origin;
      if (
        (origin && !hosts.some((h) => origin === `http://${h}`)) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        throw new EditorError('Open this editor directly on localhost.', 403);
      if (closing) throw new EditorError('The editor is shutting down.', 503);
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`),
        pathname = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        const supplied = req.headers['x-editor-token'];
        if (
          typeof supplied !== 'string' ||
          !/[a-f0-9]{64}/.test(supplied) ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          throw new EditorError('Reload the editor before continuing.', 403);
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        json(res, 200, { token, ready: true, version: '2', limits: { maxBytes: MAX_BYTES } });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/media') {
        json(res, 200, { media: [...media.values()].map(publicMedia) });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/projects') {
        json(res, 200, {
          projects: [...store.projects.values()]
            .map((record) => ({
              id: record.project.id,
              title: record.project.title,
              updatedAt: record.updatedAt,
            }))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        });
        return;
      }
      const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
      if (projectMatch && validId(projectMatch[1])) {
        const id = projectMatch[1];
        if (req.method === 'GET') {
          const record = store.projects.get(id);
          if (!record) throw new EditorError('Project not found.', 404);
          json(res, 200, record);
          return;
        }
        if (req.method === 'PUT') {
          const body = await jsonBody(req);
          let project: Project;
          try {
            project = normalizeProject(body.project);
          } catch (error) {
            throw new EditorError(String((error as Error).message));
          }
          if (project.id !== id)
            throw new EditorError('Project identity does not match its save location.');
          json(res, 200, await store.saveProject(project));
          return;
        }
        if (req.method === 'DELETE') {
          await store.deleteProject(id);
          json(res, 200, { removed: true });
          return;
        }
      }
      if (req.method === 'POST' && pathname === '/api/media') {
        if (uploading) throw new EditorError('Wait for the current file to finish importing.', 409);
        const kind = url.searchParams.get('kind');
        if (kind !== 'video' && kind !== 'music' && kind !== 'image')
          throw new EditorError('Choose a video, music or image file.');
        const name = (url.searchParams.get('name') ?? 'Recording.mp4')
          .replace(/[\u0000-\u001f]/g, '')
          .slice(0, 240);
        const contentLength = Number(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_BYTES)
          throw new EditorError('Choose a file smaller than 8 GB.', 413);
        const id = randomUUID(),
          path = join(uploads, `${id}.media`);
        let size = 0;
        uploading = true;
        const controller = new AbortController();
        let importFinished!: () => void;
        const task = {
          controller,
          done: new Promise<void>((done) => {
            importFinished = done;
          }),
        };
        activeImport = task;
        const disconnected = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once('close', disconnected);
        try {
          const limit = new Transform({
            transform(chunk, _encoding, callback) {
              size += chunk.length;
              callback(
                size > MAX_BYTES ? new EditorError('Choose a file smaller than 8 GB.', 413) : null,
                chunk,
              );
            },
          });
          await pipeline(req, limit, createWriteStream(path, { flags: 'wx' }), {
            signal: controller.signal,
          });
          const info = await probeMedia(path, kind, controller.signal);
          if (closing || controller.signal.aborted) throw new EditorError('Import cancelled.', 499);
          const item: Media = { id, name, kind, path, size, ...info, url: `/api/media/${id}` };
          media.set(id, item);
          try {
            await store.saveMedia();
          } catch (error) {
            media.delete(id);
            throw error;
          }
          json(res, 201, publicMedia(item));
        } catch (error) {
          await remove(path);
          throw error;
        } finally {
          res.removeListener('close', disconnected);
          uploading = false;
          if (activeImport === task) activeImport = null;
          importFinished();
        }
        return;
      }
      const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(pathname);
      if (mediaMatch && uuid.test(mediaMatch[1])) {
        const item = media.get(mediaMatch[1]);
        if (!item) throw new EditorError('This imported file is no longer available.', 404);
        if (req.method === 'DELETE') {
          await store.deleteMedia(item.id, () => !!active?.sourceIds.includes(item.id));
          json(res, 200, { removed: true });
          return;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const ext = extname(item.name).toLowerCase();
          const mime: Record<string, string> = {
            '.mp4': 'video/mp4',
            '.mov': 'video/quicktime',
            '.webm': 'video/webm',
            '.mkv': 'video/x-matroska',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.ogg': 'audio/ogg',
            '.flac': 'audio/flac',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
          };
          await sendFile(
            req,
            res,
            item.path,
            mime[ext] ?? (item.kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
          );
          return;
        }
      }
      if (req.method === 'POST' && pathname === '/api/exports') {
        if (active)
          throw new EditorError(
            'An export is already running. Wait for it or cancel it first.',
            409,
          );
        const body = await jsonBody(req);
        // Another request can finish reading its body while this request awaits.
        if (active)
          throw new EditorError(
            'An export is already running. Wait for it or cancel it first.',
            409,
          );
        if (body.project) {
          let project: Project;
          try {
            project = validateProject(body.project, media);
          } catch (error) {
            throw new EditorError((error as Error).message);
          }
          validateRenderBudget(project, media);
          const quality = body.quality ?? 'high';
          if (!['high', 'compact'].includes(quality))
            throw new EditorError('Unknown export quality.');
          const filename =
            (typeof body.filename === 'string' ? body.filename : project.title)
              .replace(/\.mp4$/i, '')
              .replace(/[^a-zA-Z0-9 _.-]/g, '')
              .replace(/^\.+/, '')
              .trim()
              .slice(0, 90) || 'clip';
          json(res, 202, publicJob(newTimelineJob(project, quality, `${filename}.mp4`)));
        } else json(res, 202, publicJob(newJob(validateEdit(body, media))));
        return;
      }
      const jobMatch = /^\/api\/exports\/([^/]+)(\/file)?$/.exec(pathname);
      if (jobMatch && uuid.test(jobMatch[1])) {
        const job = jobs.get(jobMatch[1]);
        if (!job) throw new EditorError('This export is no longer available.', 404);
        if (jobMatch[2] && (req.method === 'GET' || req.method === 'HEAD')) {
          if (job.status !== 'complete') throw new EditorError('The export is not ready yet.', 409);
          await sendFile(req, res, job.path, 'video/mp4', job.filename);
          return;
        }
        if (!jobMatch[2] && req.method === 'GET') {
          json(res, 200, publicJob(job));
          return;
        }
        if (!jobMatch[2] && req.method === 'DELETE') {
          job.cancel();
          await job.done;
          json(res, 200, publicJob(job));
          return;
        }
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const studioRoutes: Record<string, string> = {
          '/': 'index.html',
          '/index.html': 'index.html',
          '/studio/app.js': 'app.js',
          '/studio/preview.js': 'preview.js',
          '/studio/model.js': 'model.js',
          '/studio/style.css': 'style.css',
          '/studio/api.js': 'api.js',
          '/studio/timeline.js': 'timeline.js',
        };
        const studio = studioRoutes[pathname];
        if (studio && !options.legacyUi) {
          const data = await readFile(join(STUDIO, studio));
          res.writeHead(200, {
            'Content-Type': studio.endsWith('.html')
              ? 'text/html; charset=utf-8'
              : studio.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
          return;
        }
        const routes: Record<string, [string, string]> = {
          '/': ['index.html', 'text/html; charset=utf-8'],
          '/index.html': ['index.html', 'text/html; charset=utf-8'],
          '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
          '/style.css': ['style.css', 'text/css; charset=utf-8'],
        };
        const file = routes[pathname];
        if (file) {
          const data = await readFile(join(WEB, file[0]));
          res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
          res.end(req.method === 'HEAD' ? undefined : data);
          return;
        }
      }
      throw new EditorError('Not found.', 404);
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(res, error instanceof EditorError ? error.status : 500, {
          error:
            error instanceof EditorError
              ? error.message
              : 'Something went wrong. Try again or restart the editor.',
        });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4181, options.host ?? '127.0.0.1', done);
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    url,
    server,
    async close() {
      closing = true;
      const job = active,
        importing = activeImport;
      job?.cancel();
      importing?.controller.abort();
      server.closeAllConnections();
      await Promise.all([job?.done, importing?.done]);
      await store.flush();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startEditorServer({
    port: Number(process.env.CLIP_EDITOR_PORT ?? 4181),
    storageDir: process.env.CLIP_EDITOR_DATA,
  });
  console.log(
    `Clip editor ready: ${app.url}\nFiles and exports stay in ${resolve(process.env.CLIP_EDITOR_DATA ?? DEFAULT_DATA)}`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
}
