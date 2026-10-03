import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { openStore } from '../store';
import { EditorError, type Media } from '../media';
import { createProject, appendClip, validateProject } from '../studio/model.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'clip-store-test-'));
  t.after(async () => {
    const inside = relative(resolve(tmpdir()), resolve(root));
    assert.ok(
      inside.startsWith('clip-store-test-') && !inside.startsWith('..') && !isAbsolute(inside),
    );
    await rm(root, { recursive: true, force: true });
  });
  const store = await openStore(root),
    id = randomUUID(),
    bytes = Buffer.from('imported working copy: never delete while referenced');
  const source: Media = {
    id,
    name: 'test.mp4',
    kind: 'video',
    path: join(root, 'imports', `${id}.media`),
    url: `/api/media/${id}`,
    size: bytes.length,
    duration: 2,
    width: 320,
    height: 180,
    fps: 30,
    hasAudio: false,
    hdr: false,
  };
  await writeFile(source.path, bytes);
  store.media.set(id, source);
  await store.saveMedia();
  const project = appendClip(createProject({ width: 320, height: 180, fps: 30 }), source);
  return { root, store, source, bytes, project };
}

test('a project save queued before media deletion protects its working copy and persisted reference', async (t) => {
  const { root, store, source, bytes, project } = await fixture(t);
  // Queue both operations in the same turn: no timing delay or filesystem speed assumption.
  const saved = store.saveProject(project);
  const rejected = assert.rejects(
    store.deleteMedia(source.id, () => false),
    (error: unknown) =>
      error instanceof EditorError && error.status === 409 && /saved project/.test(error.message),
  );
  await Promise.all([saved, rejected]);
  await store.flush();
  assert.deepEqual(await readFile(source.path), bytes);
  assert.ok(store.media.has(source.id));
  assert.deepEqual(store.projects.get(project.id)?.project, project);
  const index = JSON.parse(await readFile(join(root, 'media.json'), 'utf8'));
  assert.deepEqual(
    index.media.map((item: { id: string }) => item.id),
    [source.id],
  );
  const reopened = await openStore(root);
  assert.ok(reopened.media.has(source.id));
  assert.deepEqual(reopened.projects.get(project.id)?.project, project);
  assert.deepEqual(validateProject(project, reopened.media), project);
});

test('deleting unused media before a later project save preserves that project as an unresolved reference', async (t) => {
  const { root, store, source, project } = await fixture(t);
  // A subsequent save may intentionally retain missing IDs for the relink workflow.
  const deletion = store.deleteMedia(source.id, () => false);
  const saved = store.saveProject(project);
  await Promise.all([deletion, saved]);
  await store.flush();
  await assert.rejects(stat(source.path), { code: 'ENOENT' });
  assert.equal(store.media.has(source.id), false);
  assert.deepEqual(store.projects.get(project.id)?.project, project);
  const index = JSON.parse(await readFile(join(root, 'media.json'), 'utf8'));
  assert.deepEqual(index.media, []);
  const reopened = await openStore(root);
  assert.equal(reopened.media.has(source.id), false);
  assert.deepEqual(reopened.projects.get(project.id)?.project, project);
  assert.throws(() => validateProject(project, reopened.media), /relink|missing|unavailable/i);
});

test('a newly active export blocks a queued deletion before changing files or the index', async (t) => {
  const { root, store, source, bytes } = await fixture(t);
  let exporting = false;
  const deletion = store.deleteMedia(source.id, () => exporting);
  exporting = true;
  await assert.rejects(
    deletion,
    (error: unknown) =>
      error instanceof EditorError && error.status === 409 && /export/.test(error.message),
  );
  assert.deepEqual(await readFile(source.path), bytes);
  assert.ok(store.media.has(source.id));
  const reopened = await openStore(root);
  assert.ok(reopened.media.has(source.id));
  // A rejected transaction must not poison later writes.
  exporting = false;
  await store.deleteMedia(source.id, () => exporting);
  await store.flush();
  await assert.rejects(stat(source.path), { code: 'ENOENT' });
  assert.equal((await openStore(root)).media.size, 0);
});
