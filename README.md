# Local Cut

A local timeline video editor: cut and arrange recordings, add image/video layers, mix music, and export an MP4. No account, external uploads, watermark, or subscription. Original recordings are never overwritten.

This is an independent repository with its own dependencies, tests, and local media storage. Original editor source is MIT licensed. Dependency and media licences remain separate—see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Start

Install Node.js 22.12 or newer, then clone the repository and install its dependencies:

```sh
git clone https://github.com/gavogavogavo/local-cut.git
cd local-cut
npm ci
npm start
```

Open **http://127.0.0.1:4181/** in Chrome or Edge. On Windows, after installation, double-click **Start Editor.cmd**. Keep the server window open while editing/exporting.

The install downloads FFmpeg locally. Absolute executable paths can be supplied through `FFMPEG_BIN` and `FFPROBE_BIN`. `CLIP_EDITOR_PORT` changes the default port; `CLIP_EDITOR_DATA` changes the working-data directory. The server binds only to 127.0.0.1.

## Edit

1. **Import** video, PNG/JPEG images, or audio into the media bin. MP4 with H.264/AAC is the most reliable preview format; MP3/WAV are good audio choices.
2. Add videos to the **main track**. Select a clip, seek, and press **S** to split. Delete unwanted pieces. Drag clips or use earlier/later buttons to reorder. Adjust source in/out points, speed, volume, and fit in the inspector.
3. Add images/videos as **layers**. Set start, duration, position, size, opacity, fades, and video volume. Drag a layer in the preview to move it; drag its corner to resize. PNG transparency is preserved. Layer order controls which picture is on top.
4. Add music/sound to **audio tracks**. Set placement, source offset, volume, fades, and looping. Multiple tracks can overlap. Original clip audio has its own volume.
5. Choose landscape, portrait, or square **canvas settings**, resolution, and frame rate. Export MP4, watch progress, and download. Cancelling an export leaves your project and sources unchanged.

**Space** plays/pauses; **Left/Right** steps a frame; **S** splits; **Delete** removes the selection; **Ctrl/Cmd+Z** undoes; **Ctrl/Cmd+Shift+Z** redoes. Shortcuts do not replace typing inside fields.

## Projects and timing

Projects autosave locally. The Projects menu opens saved work or starts a new project. Save project downloads a JSON edit description with a media manifest, **not the media files**. Transfer the sources separately and relink when moving to another computer. Back up the entire data directory to preserve everything.

Main clips join without gaps. Each clip duration rounds to a whole output frame. Source trims use source seconds; speed changes preserve audio pitch. Deleting/shortening a main clip moves later main clips earlier. **Picture and audio layers retain absolute timeline positions**; adjust them when they need to follow an edit. Layers do not extend the main sequence.

Fades remain at authored times; shortening the main sequence does not shift them earlier. Non-looping audio falls silent when its source ends and fades out at that audible end. Looping starts at the selected offset, then repeats the full source.

The browser preview is for interactive editing, not sample-accurate mixing. FFmpeg produces the final file with fixed frame timing. No proxies are generated; high-resolution or many simultaneous videos can slow preview playback.

## Exports and current scope

SDR H.264 MP4, stereo 48 kHz AAC audio. High quality uses CRF 18; Smaller file uses CRF 23. Picture layers use higher-quality intermediate renders. Cuts re-encode and can fall between source keyframes. Exports use the CPU and need disk space for imported copies, temporary renders, and output.

This is a lightweight editor, not a complete professional suite. It has **no titles/text tool, clip transitions, animation keyframes, colour grading, captions, waveform display, proxies, or collaboration**. PNG artwork can serve as titles. Static PNG/JPEG are supported; WebP/animated images are not. HDR is rejected. Browser support for HEVC, MKV, and unusual codecs varies; a file may export when it cannot preview.

Limits: 8 GB per import; one-hour main timeline; 128 main clips, 32 picture layers, 32 audio tracks; canvas up to 8,294,400 pixels and 3840 pixels per dimension; 24/25/30/50/60 FPS. A 48-million-pixel aggregate picture-work budget rejects unusually heavy export layer stacks, including non-overlapping picture layers. This reduces risk but is not a fixed memory guarantee. Reduce resolution or flatten layers if needed. One import and one export run at a time.

## Local files

By default, `.clip-editor` lives beside `server.ts` in this repository, regardless of the terminal working directory:

- `imports/`: working copies.
- `media.json`: persistent media metadata and IDs.
- `projects/`: saved edit descriptions.
- `exports/`: completed MP4s, in addition to browser downloads.

Projects/media survive restarts. Export links/progress are session-scoped, but finished files remain on disk. Temporary renders are removed after completion/cancellation. A force-quit can leave `.render-*` directories; remove only those temporary directories when no export is running. Imported media and finished exports are not automatically deleted. Imports from version 1 before the persistent index existed need importing again; originals remain unchanged.

The server validates local host/origin and uses a per-start token for changes. It is for personal local use, **not public hosting**. No analytics, external fonts, or remote media service. Tab throttling/sleep may disrupt live preview; exported timing is independent of playback.

## Verify and contribute

```sh
npm run check
npm test
npm run test:browser
```

Browser checks use installed Microsoft Edge on Windows and Google Chrome on Linux/macOS for H.264/AAC playback. If Chrome is missing, install it with `npx playwright install --with-deps chrome`. `EDITOR_QA_BROWSER` overrides the browser channel (`chrome` or `msedge`).

Tests generate synthetic media and verify decoded frames/audio, model operations, persistence, cancellation, and browser flows. See [VALIDATION.md](VALIDATION.md), [tests/README.md](tests/README.md), and [CONTRIBUTING.md](CONTRIBUTING.md). The CI workflow runs from this repository root on pushes and pull requests. The source repository is [gavogavogavo/local-cut](https://github.com/gavogavogavo/local-cut); the editor runs locally on your computer. On Windows, `scripts/package-source.ps1` builds a source ZIP without dependencies, personal media, or migration backups.
