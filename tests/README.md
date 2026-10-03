# Native timeline verification

Run the editor package's test command. `export.test.ts` starts an isolated local server on an ephemeral port and generates its own tiny media with the bundled FFmpeg. Temporary inputs, imports, intermediate renders, and exports are removed after the test run. No game code or user media is required.

The expected result comes from the fixture definitions, not from the composition implementation:

- A red video changes to blue at source time 1 second. Its audio changes from 440 Hz to 660 Hz at the same moment. This checks cuts, ordering, speed, pitch, and A/V alignment.
- A green 4:3 video at 24 FPS checks normalization into a 16:9 canvas at 30 FPS.
- A raw RGBA image has a half-transparent white left half and a fully transparent right half. Its expected composite on black follows source alpha × layer opacity × fade progress.
- A yellow video changes to magenta, and its audio changes from 880 Hz to 1320 Hz. This checks video-overlay source offsets and absolute placement.
- Music contains an 880 Hz tone with known one-second amplitude steps, plus a separate 660 Hz track. These make offset, whole-track looping, multiple tracks, fades, and silent intervals independently measurable.

Decoded RGB comparisons use a predeclared 12/255 channel bound, or 8/255 for grayscale alpha composites, to accommodate H.264/YUV conversion. Audio tests measure sine/cosine projections at the known frequencies; allowed amplitude errors are specified in each assertion, generally 0.005–0.01. Silent intervals must have RMS below 0.0005. Frame counts and selected color-cut boundaries must match exactly. Export duration tolerates container/frame representation by at most 0.025–0.04 seconds, depending on the fixture.

The suite also checks persistence across a real server restart, stable imported media IDs, missing-reference rejection, cancellation, partial-file access prevention, and successful export after cancellation. The measured results are saved to `native-results.json`.

Additional regressions verify delayed audio through base-clip speed changes and video overlays, exact cut colors and presentation timestamps at every supported frame rate (24/25/30/50/60 FPS), authored fades beyond the main end, and final-frame overlay padding. The timing checks require the exact frame rate and compare every frame timestamp with a one-microsecond tolerance, including rates that cannot be represented in whole milliseconds. The visible layer budget is exercised through the HTTP API. One three-second 1080p60 export with image and video layers records wall time as a smoke check; its simple generated footage does not establish general encoding performance.
