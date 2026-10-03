# CLAUDE.md — gss-stats

Project rules for this repo — for both AI agents and human contributors. See
[README.md](README.md) for what the project is and how it's built.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`.
- **Scope** is optional but encouraged — e.g. `filter`, `charts`, `sites`, `drill`,
  `stats`, `geo`, `auth`, `deploy`.
- Keep the subject imperative and short (~72 chars); put detail in the body.
- Commits made by an AI agent append a trailer:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Changelog

Every user-facing change adds a bullet under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md), **in the same commit as the code**. Keep-a-Changelog
format; concise bullets (bold lead + one sentence, no filenames or implementation
detail). Every merge to `main` is a release: the landing PR promotes `[Unreleased]` to the
next semver version (`## [X.Y.Z] — YYYY-MM-DD`) and bumps `package.json` in the same PR.

## Branches

`main` is the deployed line. Do work on `feat/<scope>` / `fix/<scope>` /
`docs/<scope>` / `chore/<scope>` branches. Feature branches still don't bump while in
progress — record changes under `[Unreleased]`; the landing PR to `main` does the semver
bump and changelog promotion (see Changelog).

## Destructive git safety

Before any `push --force`, `reset --hard`, or deleting an origin-tracked branch:
back it up first and verify the backup pushed —

```bash
git branch backup/<branch>-YYYY-MM-DD origin/<branch>
git push origin backup/<branch>-YYYY-MM-DD
```

## Documentation discipline

Each fact lives in **one** file; cross-reference rather than duplicate. Update
`README.md` and `CHANGELOG.md` in the same commit as any behavior change so docs
never drift from the code.

## Deploy

Merges to `main` deploy automatically via GitHub Actions
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)), using the
`CLOUDFLARE_API_TOKEN` repo secret. A manual `wrangler` deploy is still available
locally — its analytics token comes from a local, **gitignored** file (never commit
it). See the [Deploy](README.md#deploy) and
[Local development](README.md#local-development) sections of the README.

## Not yet set up (optional follow-ups)

- husky `pre-commit` (lint/format via lint-staged) — needs a lint toolchain first.
- A changelog-style check on `[Unreleased]` bullets.
