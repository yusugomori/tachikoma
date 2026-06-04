# Contributing to Tachikoma

Thanks for your interest. Tachikoma is a small project and this guide is intentionally short.

## Getting started

```bash
pnpm install
pnpm build
pnpm tachikoma --help
```

`README.md` (and `README.ja.md`) is the single source of documentation — there is no separate docs tree.

## Before opening a pull request

Run the full check suite locally; CI runs the same steps:

```bash
pnpm lint        # biome (format + lint)
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build
```

- Branch from `main` and keep each PR focused on one logical change.
- Match the surrounding code style; `pnpm lint:fix` applies biome's formatting.
- Add or update tests for behavior changes. New CLI commands and services should
  ship with tests under `test/` (see the existing `*-service` and integration tests).
- Update `README.md` and `README.ja.md` together when a change is user-visible.

## Reporting bugs and requesting features

Open an issue at [`yusugomori/tachikoma`](https://github.com/yusugomori/tachikoma/issues).
For bugs, include the Tachikoma version (`tachikoma --version`), the host agent
(Claude Code / Codex), and a minimal reproduction. `tachikoma doctor` output is
helpful for integration problems.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
