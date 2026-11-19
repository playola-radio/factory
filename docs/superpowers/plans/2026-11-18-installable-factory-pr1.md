# Installable factory, PR 1: settings

Spec: `docs/superpowers/specs/2026-11-18-installable-factory-design.md`. Settings are loaded and checked once in
`bin/factory.ts`; small values are passed into `realWorkshop`, `watchPr` and `runAgent`.
Out of scope here (PR 2/3): `designs/` to `factory/`, `config.json`, `afterPush`, `qa-rules.md`, skill changes, LICENSE, the plan table's `Hard` column.

## Stage 1: Settings file checks
**Goal**: `lib/settings.ts` with pure `checkSettings(json)` and `loadSettings(home)`.
**Success Criteria**: every problem is collected; unknown fields at any level are errors; `bot.login` equal to `owner` (any case) is refused; `greptile.reReviewBelow` is an integer 1-5 (default 4); a missing file, bad JSON or problems give one error ending `Run "factory init" to fix it.`
**Tests**: `test/settings.test.ts`: minimal file, full file, each required field missing, wrong types, unknown fields top-level and nested, bot == owner in different cases, reReviewBelow out of range, several problems together, missing file, bad JSON.
**Status**: Not Started

## Stage 2: Optional model and settings values in the agents and workshop
**Goal**: `model?: string` on agent calls (`--model`/`-m` only when set); `realWorkshop` takes owner, bot, greptile and models; no hardcoded `briankeane` / `marge-watson`.
**Success Criteria**: with no models set, spawned CLI args carry no model flag; with Brian's settings they carry `opus` (Claude) and `gpt-6-astra` (Codex). Bot token comes from `gh auth token --user <bot.login>`.
**Tests**: `test/models.test.ts` spawns fake `claude` and `codex` and asserts arguments, with and without models, and with Brian's settings.
**Status**: Not Started

## Stage 3: Greptile optional, re-review threshold, case-insensitive logins
**Goal**: `PullRequestState.greptile: { score: number | null } | null`; the `/greptile/i` failed-check filter and `@greptile review this` only when Greptile is set; threshold passed into `watchPr`; logins compared case-insensitively; prompts label non-owners `reviewer`.
**Success Criteria**: no Greptile means no re-review and a check named "greptile" is not hidden; with Greptile, a score below the threshold triggers a re-review, at/above or missing/unreadable does not; a human non-owner thread is answered as a `reviewer`.
**Tests**: extend `test/build.test.ts` (neutral fixtures `owner-login` / `bot-login`).
**Status**: Not Started

## Stage 4: Base default and FACTORY_HOME
**Goal**: base is `--base`, then the claim's base, then GitHub's default branch (bot token); `FACTORY_HOME` defaults to `~/.config/factory`; usage text is generic.
**Success Criteria**: a claim survives a changed GitHub default; a conflicting explicit `--base` keeps today's error; failure names the repo and suggests `--base`.
**Tests**: `test/base.test.ts` for the pure base resolver.
**Status**: Not Started

## Stage 5: `factory init` and command wiring
**Goal**: `lib/init.ts` (injected asker and `gh`); `bin/factory.ts` reads settings per command (`status`/`abandon` never, `finalize` optional for `models`, `build` required plus bot token check before any work).
**Success Criteria**: scripted answers write the expected file; failing bot token writes nothing; bot == owner refused; existing values are defaults; a file that is not factory settings is left untouched and named in the error.
**Tests**: `test/init.test.ts`.
**Status**: Not Started

## Stage 6: README setup section
**Goal**: prerequisites, clone, `./install.sh`, `factory init`, settings reference, one terminal per repo, do not change owner/bot mid-build.
**Success Criteria**: README matches the spec; no source file outside tests, spec, plan and README names `briankeane`, `marge-watson` or `Marge`.
**Tests**: grep check.
**Status**: Not Started

## Checklist: every PR-1 row and test bullet mapped

| Item | Stage |
|---|---|
| Parity: bot `marge-watson`/`Marge`/email to `settings.bot` | 2 |
| Parity: bot token from `gh auth token --user <bot.login>` | 2, 5 |
| Parity: owner to `settings.owner` | 2, 3 |
| Parity: Greptile parsing/filter/re-review only when set | 3 |
| Parity: re-review threshold to `greptile.reReviewBelow` | 1, 3 |
| Parity: models to `settings.models` | 2 |
| Parity: base default is GitHub's default branch | 4 |
| Parity: usage text generic | 4 |
| Parity: `~/.config/factory` | 4 |
| Hardcoded rows: reviewer labels, `forBots` kept | 3 |
| Hardcoded rows: neutral fixtures | 3 |
| Settings file, Validation, command table (settings), `factory init` | 1, 5 |
| README setup section | 6 |
| Tests: checkSettings, loadSettings | 1 |
| Tests: factory init | 5 |
| Tests: models (incl. Brian's settings) | 2 |
| Tests: base (flag > claim > GitHub; claim survives) | 4 |
| Tests: review loop (no Greptile, below/at/above/missing, human reviewer) | 3 |
