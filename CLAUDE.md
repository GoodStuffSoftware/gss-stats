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
detail). Every merge to `main` is a release: the landing merge promotes `[Unreleased]` to the
next semver version (`## [X.Y.Z] — YYYY-MM-DD`) and bumps `package.json` in the same commit.

## Branches

`main` is the deployed line. Do work on `feat/<scope>` / `fix/<scope>` /
`docs/<scope>` / `chore/<scope>` branches. Feature branches still don't bump while in
progress — record changes under `[Unreleased]`; the landing merge to `main` does the semver
bump and changelog promotion (see Changelog).

Mike doesn't review PRs (2026-10-06): the writer spawns its own parity reviewer, runs one fix round, then merges to main and verifies the deploy; Mike looks at the live result.

Publishing (Mike, 2026-10-29: "You don't have to put stuff up on Dev unless I tell you just publish it so I can see the changes"): every change, large or small, publishes straight to production. The dev preview (https://dev.gss-stats.pages.dev) is used only when Mike asks for it. This replaces the 2026-10-27 rule that sent large dashboard changes to the preview first. When the change lands, give Mike a concrete look-at-X list: the page, tab or card to open, and what he should see.
