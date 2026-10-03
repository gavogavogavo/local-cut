# Local Cut validation

Tested 2 October 2026 on Windows with project-local FFmpeg/ffprobe. The editor is separate from the surf game; no movement, renderer, or map changes were made for this work.

## Automated model, storage, and native export tests

The standalone suite contains **52 tests**: 19 timeline-model, 3 storage-concurrency, 17 timeline export scenarios, and 13 legacy export regressions. All tests and their helpers now live in this repository.

Expected export results come from independently specified synthetic media, not from the composition implementation: known colour changes, transparent RGBA pixels, and audio signals with defined frequencies/amplitudes. Tests decode actual MP4 frames and PCM audio after submitting projects through HTTP.

Predeclared tolerances: RGB channel errors at most 12/255 (8/255 for alpha composites); sine amplitudes generally within 0.005–0.01; silent RMS below 0.0005. Frame counts and cut boundaries match exactly. Duration permits up to 0.025–0.04 seconds of container/frame representation, depending on fixture. Tolerances were not loosened after evaluation.

Verified:

- Cut/reordered mixed-resolution and mixed-FPS sources produce the selected canvas and correct colour sequence; a 2.5-second fixture exports exactly 75 frames at 30 FPS.
- At 25/50 FPS, concatenation has exact 38/78 frame totals, correct colours on every frame, and timestamp error below 1 microsecond against expected frame times.
- 0.5×, 1.5×, and 2× clip speed preserves audio pitch while picture/audio source events remain aligned.
- Original delayed audio stays delayed through trim and speed changes, including video-overlay placement.
- Transparent PNG position, padding, opacity, and fades survive encoding: expected quarter-white composite is RGB 64; fade samples are RGB 25; transparent regions remain black.
- Video layers use source offsets and absolute start/end times. Accepted final-frame rounding repeats the final source frame, then ends at the declared boundary.
- Multiple audio tracks retain independent gain, offset, loops, fades, and placement. Silent main clips preserve real gaps. Fully transparent video can still supply audio.
- Layers cannot lengthen the main sequence. Fades beyond the main end stay at their authored time. A 6-second fade-in over a source with 2 seconds remaining is not shortened; measured amplitudes of 0.00998 at 0.6 seconds and 0.02501 at 1.5 seconds match expected 0.01/0.025, followed by silence.
- Oversized visible layer stacks are rejected before rendering. Transparent/out-of-time picture layers do not count toward the picture-work budget.
- Project/media IDs survive an actual server restart. Missing media blocks export while unresolved projects can be saved for relinking.
- Concurrent save/delete cannot remove a newly saved project's working copy. A newly active export prevents queued media deletion.
- Malformed requests return client errors. Cancellation stops native processing, does not expose partial MP4s, and permits a successful subsequent export.

Detailed export results and measurements: [tests/native-results.json](tests/native-results.json). Fixture design: [tests/README.md](tests/README.md).

A 3-second 1920×1080/60 FPS composition with an image and video layer exported 180 frames/3.000 seconds in roughly 2 seconds on this machine, including download/probe. This is a low-complexity synthetic smoke test, **not a general performance benchmark**. Large real recordings and 4K stacks need more resources.

## Browser verification

**21/21 browser checks pass** in an isolated Microsoft Edge 154 session, with zero JavaScript exceptions. Results: [tests/browser-results.json](tests/browser-results.json). Tests use ordinary file inputs, keyboard/pointer actions, read-only state/canvas observations, and independently decoded downloads.

The checks cover import, trim, speed, source fit, split/reorder/duplicate/delete, undo/redo, image opacity/drag/resize, video layer timing/order, multiple audio tracks, playback across cuts, autosave/reload, portable project JSON/relinking, actual export/download, cancellation, duplicate-export prevention, save-failure protection, invalid-import recovery, project reopening, aspect presets, frame stepping, zoom, and narrow layouts. Reselecting clips/audio also verifies actual slider positions match their fractional values.

The browser-created layered MP4 contains exactly 75 frames at 30 FPS, 320×180, and 2.5 seconds, with the expected red/blue/green sequence. Live preview source synchronization stays within the predeclared 0.22-second observation tolerance. Desktop and 390-pixel-wide screenshots were visually inspected. The two expected console HTTP errors are deliberate invalid-media (400) and failed-save (503) tests; both recover successfully.

## Independent review

Separate agents authored the immutable model and independent native fixtures, then reviewed backend and frontend behavior. Resolved findings include serialized save/delete protection, authored fade timing, final overlay-frame padding, and an aggregate export picture-work limit. Review also checks save-failure navigation, preview cancellation, pointer cleanup, and duplicate export submission.

A separate copy of the source package was installed with `npm ci`; type checks and all 39 standalone tests passed there. The release includes its own dependency lockfile, launcher, MIT licence, third-party notices, contributor guide, formatter, and CI workflow. User media, game assets, installed dependencies, and native executables are excluded from the source archive. Windows is the tested platform; Linux/macOS compatibility is intended but has not been claimed as tested.

## Practical limits

Browser playback is approximate and codec-dependent. It does not reproduce the export peak limiter/sample-accurate mix. CPU export is authoritative. We do not claim exhaustive 8 GB/one-hour stress testing, all codec/platform combinations, or professional colour management. PNG/JPEG only; HDR is rejected. No proxy pipeline or GPU encoder is supplied.

This is a local lightweight editor with cuts, layers, audio, and saved projects—not a complete professional suite. Remaining features and format/resource limits are documented in [README.md](README.md). The source archive is independently installable. The editor runs locally; no hosted editing service is provided.


## Repository separation — 3 October 2026

Local Cut now lives in its own repository and has no runtime, dependency, script, or test imports from the Surf project. The legacy test helpers, reports, source packager, and screenshot history moved with it. The default working-data path is anchored beside server.ts rather than the terminal's working directory.

Validation after the move: all 52 automated tests and all 21 browser checks passed from the new repository; type checking passed. Both saved projects were verified through the restarted HTTP API against their on-disk records. All seven migrated data files (605,808,541 bytes total, including older unindexed media and completed exports) were compared by SHA-256 before and after moving. Their IDs and contents are unchanged.

At the end of the separation, Git was initialized locally with no remote configured. User media, dependency installations, migration backups, screenshots, and generated source archives are ignored. A private migration manifest and previous generated release copies are kept in .migration-backup; they are excluded from the source ZIP.

## Initial GitHub publication checks — 3 October 2026

Prepared the source for [gavogavogavo/local-cut](https://github.com/gavogavogavo/local-cut). All 52 automated tests and all 21 isolated Edge browser checks passed again on Windows with Node.js 24.13.0. Type checking and formatting checks passed. The README includes clone instructions, and local environment files are excluded from Git alongside media and generated artifacts. These checks do not establish Linux/macOS compatibility; the repository workflow runs the automated and browser suites on Ubuntu.
