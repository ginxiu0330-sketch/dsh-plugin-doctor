# Changelog

## 0.1.0 — 2026-11-18

First release. Read-only by construction.

- `plugin_doctor` tool: installed profile packages with per-channel upgrade status,
  DSH compatibility failures for both installed and candidate versions, bundle patch
  row/override counts, and skills shadowed by a same-named source.
- Degrades instead of throwing: a profile without a plugin manager or skill catalog
  still produces a report, with the reason recorded.
- Zero build step. `@deepseek-ai/*` are peer dependencies resolved from the host at
  load time, so nothing is installed into the profile.
