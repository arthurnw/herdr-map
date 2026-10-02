# Upstream

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- Copied from `skills/install-anti-slop/assets/anti-slop/` with that commit's `skills/install-anti-slop/scripts/install.mjs`. The assets matched `src/` (without tests) at that commit.
- Installed at `tools/oxlint/anti-slop/`, unmodified. `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.
- Installed with `oxlint` and `@oxlint/plugins` 1.86.0 (upstream develops against 1.78.0).

## Local choices

- Only the generic plugin (`index.ts`) is registered. The Effect plugin (`effect/`) was copied but isn't enabled, since herdr-map doesn't depend on Effect.
- Rule options and overrides are in `oxlint.config.ts`, each with its reason.
