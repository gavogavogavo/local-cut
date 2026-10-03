# Third-party components

The MIT licence in this directory applies to the original editor source and interface. It does not relicense dependencies, imported recordings, music, fonts, game assets, or other user media. The standalone source archive contains no game assets or user recordings, and no FFmpeg executables.

## Media tools

- **ffmpeg-static 5.3.0** is GPL-3.0-or-later. [Project and licence](https://github.com/eugeneware/ffmpeg-static). Its install script retrieves a platform-specific FFmpeg executable (release b6.1.1). This program launches FFmpeg as a separate process. The downloaded build has its own licence and build configuration; inspect `ffmpeg -L` and `ffmpeg -buildconf`.
- **ffprobe-static 3.1.0** JavaScript wrapper is MIT. [Project](https://github.com/joshwnj/ffprobe-static). Its ffprobe executables are FFmpeg binaries with separate licensing; the wrapper licence does not replace those terms.
- [FFmpeg legal information](https://ffmpeg.org/legal.html) explains LGPL/GPL build distinctions. If redistributing binaries or a packaged installer, retain the applicable licence notices and provide the corresponding source/build materials required by that particular build. This source release is not a prepackaged binary redistribution.

## JavaScript dependencies

- tsx and Prettier (MIT), TypeScript (Apache-2.0), Playwright (Apache-2.0), and Node type definitions (MIT).
- Transitive dependency licences are retained in their installed package directories. Exact versions and integrity hashes are recorded in `package-lock.json`.

Users supply their own media. The editor includes no music library, tracking, external fonts, accounts, or hosted storage.
