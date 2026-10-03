import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EditorError, type Media } from './media';
import { normalizeProject, type Project } from './studio/model.js';

export const validId = (value: string) => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
export type ProjectRecord = { project: Project; updatedAt: string };

/** Serialized atomic writes protect autosaves and the media index from partial JSON. */
export async function openStore(root: string) {
  const uploads = join(root, 'imports'),
    projectsDir = join(root, 'projects'),
    index = join(root, 'media.json');
  await Promise.all([mkdir(uploads, { recursive: true }), mkdir(projectsDir, { recursive: true })]);
  const media = new Map<string, Media>(),
    projects = new Map<string, ProjectRecord>();
  let writes = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = writes.then(task);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const atomic = async (path: string, value: unknown) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  try {
    const saved = JSON.parse(await readFile(index, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.media)) throw Error('Unsupported media index.');
    for (const item of saved.media) {
      if (!validId(item.id) || !['video', 'music', 'image'].includes(item.kind))
        throw Error('Invalid media index entry.');
      const path = join(uploads, `${item.id}.media`);
      try {
        await stat(path);
        media.set(item.id, { ...item, path, url: `/api/media/${item.id}` });
      } catch {
        /* Missing working copies are shown as unresolved references in saved projects. */
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        'The local media index could not be read. Restore its backup before starting the editor.',
        { cause: error },
      );
  }
  for (const name of await readdir(projectsDir)) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !validId(id)) continue;
    try {
      const value = JSON.parse(await readFile(join(projectsDir, name), 'utf8'));
      const project = normalizeProject(value.project);
      if (project.id !== id) throw Error('Project identity mismatch');
      projects.set(id, { project, updatedAt: value.updatedAt });
    } catch (error) {
      console.warn(
        `Could not read saved project ${id}; its file was left untouched.`,
        String(error),
      );
    }
  }
  const mediaSnapshot = () => ({
    version: 1,
    media: [...media.values()].map(({ path, ...entry }) => entry),
  });
  const saveMedia = () => serial(() => atomic(index, mediaSnapshot()));
  return {
    media,
    projects,
    saveMedia,
    deleteMedia: async (id: string, isExporting: () => boolean) =>
      serial(async () => {
        const item = media.get(id);
        if (!item) throw new EditorError('This imported file is no longer available.', 404);
        if (isExporting())
          throw new EditorError('Wait for the export to finish before removing this file.', 409);
        if (
          [...projects.values()].some(({ project }) =>
            [...project.clips, ...project.overlays, ...project.audio].some(
              (layer) => layer.mediaId === id,
            ),
          )
        )
          throw new EditorError(
            'This file is used by a saved project. Remove it from that project first.',
            409,
          );
        media.delete(id);
        try {
          await atomic(index, mediaSnapshot());
        } catch (error) {
          media.set(id, item);
          throw error;
        }
        await unlink(item.path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }),
    saveProject: async (project: Project) =>
      serial(async () => {
        const record = { project, updatedAt: new Date().toISOString() };
        await atomic(join(projectsDir, `${project.id}.json`), record);
        projects.set(project.id, record);
        return record;
      }),
    deleteProject: async (id: string) =>
      serial(async () => {
        await unlink(join(projectsDir, `${id}.json`)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        projects.delete(id);
      }),
    flush: () => writes,
  };
}
