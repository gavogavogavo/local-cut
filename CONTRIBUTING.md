# Contributing

Requires Node 22.12+ and npm. Run `npm ci`, `npm run check`, and `npm test` from this directory. For browser tests, install Chromium with `npx playwright install chromium`, then run `npm run test:browser`. These tests generate their own media; no game files are needed. The 13 legacy export regressions are included in `npm test`; the original interface can also be checked with `npm run test:legacy:browser`.

Run `npm run format` before submitting code. `npm run format:check` verifies the shared formatting rules without changing files.

## Design

- `studio/model.js` is the shared immutable timeline model, used by the browser, server, and tests. Keep it free of browser and server dependencies.
- `studio/app.js`, `preview.js`, and `style.css` implement the browser workspace and preview. Browser playback is an interactive approximation; FFmpeg produces the exported file.
- `server.ts` is a loopback-only HTTP server. Mutations require a per-start token and same-origin requests. Do not turn it into a public multi-user service without designing authentication, resource quotas, and isolated media processing.
- `store.ts` writes media metadata and projects atomically. Originals are never edited; imports are working copies.
- `composition.ts` renders sequential main clips, then combines layers/audio. Keep preview/export timing rules consistent and avoid loading entire recordings into memory.
- `media.ts` probes media and retains the previous single-selection export API for compatibility.

Timing is measured in seconds; main clips are rounded to integer output frames individually. Main clips join without gaps. Removing or changing a main clip ripples subsequent main clips, while image/video/audio layers stay at their absolute timeline positions. Source trims refer to source seconds. Clip speed affects duration while preserving audio pitch. The shared model enforces limits and validates media references before export.

Add meaningful generated-media fixtures for changes to trim, sync, compositing, or mixing. State expected decoded pixels/audio values independently of the export implementation and choose tolerances before evaluating the output. Keep sample media small and synthetic. Browser checks should exercise real input, saved state, downloads, and errors.

Send changes under the MIT licence in `LICENSE`; keep dependency licences separate. Never commit personal recordings, `.clip-editor`, credentials, or generated executables.
