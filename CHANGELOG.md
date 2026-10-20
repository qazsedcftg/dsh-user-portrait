# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [0.1.0] - 2026-10-20

First public release. The plugin had been developed and used locally; this
release makes the package installable and self-describing. Versions now start
at 0.1.0 instead of the internal 1.x numbering.

### Added

- `LICENSE` (MIT), `.gitignore`, `CHANGELOG.md`, and an English `README.md`
  next to the existing Chinese documentation, now `README.zh.md`.
- `test/` with the twelve regression suites, an `npm test` runner, and a
  GitHub Actions workflow. Suites resolve paths from their own location, so a
  checkout works on any machine; suites that need a local DSH installation or
  sample portrait data print an explicit `SKIP` instead of failing.
- `assets/screenshot.png` and `assets/user-portrait-preview.html` for the
  marketplace card and offline design review.
- Package metadata required for publishing: `engines`, `keywords`, `scripts`,
  and the un-scoped package name `dsh-user-portrait`.

### Fixed

- `portrait_read` with a `dimension` filter reported the whole profile's active
  entry count instead of the filtered dimension's, contradicting the rendered
  header. The counter now follows the filter.
- The blacklist round-trip suite failed on real data whenever the only retired
  conclusion had all of its turns shared with an active conclusion. It now
  asserts the exact pinned set and covers the rowless-purge case with a
  synthetic entry, so it no longer depends on which data happens to be present.
- Documentation no longer claims five panel tabs, ten dimensions, or a
  three-turn synthesis cadence: the panel has four tabs, the portrait nine
  dimensions, and synthesis runs every turn by default.

### Changed

- Package renamed from the local alias `@local/dsh-user-portrait` to
  `dsh-user-portrait` across `package.json`, `cordis.patch.yml`, the client
  loader id, and every module docstring.
- The bundled `debug.log` (browser crashpad noise) was removed.
- The twelve suites now share `test/_harness.mjs` for assertions and summary,
  resolve every path from `test/_paths.mjs`, and `npm run check:package`
  rejects machine-specific paths under `test/`.
