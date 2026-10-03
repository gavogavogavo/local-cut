export const PROJECT_VERSION: 2;
export const FRAME_RATES: readonly [24, 25, 30, 50, 60];
export const LIMITS: Readonly<{
  clips: 128;
  overlays: 32;
  audio: 32;
  duration: 3600;
  frameArea: 8294400;
}>;
export type FrameRate = 24 | 25 | 30 | 50 | 60;
export type ItemKind = 'clip' | 'overlay' | 'audio';
export interface Clip {
  id: string;
  mediaId: string;
  in: number;
  out: number;
  speed: number;
  volume: number;
  fit: 'contain' | 'cover';
}
export interface Overlay {
  id: string;
  mediaId: string;
  start: number;
  duration: number;
  in: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}
export interface Audio {
  id: string;
  mediaId: string;
  start: number;
  in: number;
  duration: number;
  volume: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
}
export interface Project {
  version: 2;
  id: string;
  title: string;
  width: number;
  height: number;
  fps: FrameRate;
  clips: Clip[];
  overlays: Overlay[];
  audio: Audio[];
}
export interface ModelMedia {
  id: string;
  kind: 'video' | 'image' | 'music' | 'audio';
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  name?: string;
}
export interface ActiveClip {
  clip: Clip;
  index: number;
  start: number;
  end: number;
  sourceTime: number;
}
export class ModelError extends Error {
  constructor(message: string);
}
export function createProject(
  options?: Partial<Pick<Project, 'id' | 'title' | 'width' | 'height' | 'fps'>>,
): Project;
export function normalizeProject(value: unknown): Project;
export function validateProject(
  value: unknown,
  mediaMap: Map<string, ModelMedia> | Record<string, ModelMedia>,
): Project;
export function clipFrames(project: Project, clip: Clip): number;
export function duration(project: Project): number;
/** Start seconds, aligned with project.clips; calculated from integer frame counts. */
export function clipStarts(project: Project): number[];
/** Half-open interval; returns null at the exact timeline end. */
export function clipAt(project: Project, time: number): ActiveClip | null;
/** Snaps to an output-frame boundary. The left clip retains its ID; right gets a new ID. */
export function splitClip(project: Project, clipId: string, timeAbsolute: number): Project;
export function removeItem(project: Project, kind: ItemKind, id: string): Project;
/** Main copies are inserted immediately after their source; layer copies keep absolute times. */
export function duplicateItem(project: Project, kind: ItemKind, id: string): Project;
/** newIndex is the final main-track index; clips.length also means the end. */
export function moveClip(project: Project, id: string, newIndex: number): Project;
/** Appends the available source span, up to the one-hour timeline cap; canvas stays unchanged. */
export function appendClip(project: Project, media: ModelMedia): Project;
export function addOverlay(project: Project, media: ModelMedia, at?: number): Project;
export function addAudio(project: Project, media: ModelMedia, at?: number): Project;
