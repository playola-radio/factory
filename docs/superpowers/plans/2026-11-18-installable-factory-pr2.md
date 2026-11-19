# Installable factory, PR 2: the repo's `factory/` folder

Spec: `docs/superpowers/specs/2026-11-18-installable-factory-design.md`. Designs move from `designs/` to `factory/`.
The repo's `factory/config.json` and `factory/qa-rules.md` are read from the factory's checkout of the base
(`baseView`) once per design, checked before any work, and passed into the build as plain values.
Out of scope here (PR 3): `factory/design-rules.md`, the skill's Playola specifics, fallback path, base-branch example
and "paid review" wording, the full README walkthrough, `LICENSE`, and the plan table's `Hard` column.

## Stage 1: Designs live in `factory/`
**Goal**: `factory/ready` and `factory/done` everywhere `designs/` was: `lib/design.ts`, `lib/readiness.ts`, `markDesignBuilt` in `lib/workshop.ts`, the PR body in `lib/implement.ts`, usage text and the finalize error in `bin/factory.ts`, "anything under `factory/`" in the four writer prompts, and the paths (only) in `skills/design-feature/SKILL.md`.
**Success Criteria**: `grep -rn "designs/" lib bin prompts skills` finds nothing; designs are found in `factory/ready` and `factory/done`; a design whose plan was finished in `designs/ready` and then moved to `factory/ready` is still buildable.
**Tests**: existing design, readiness and build tests on `factory/`; new: a plan sealed in `designs/ready` stays finished after the folder moves to `factory/ready`.
**Status**: Complete

## Stage 2: `checkRepoConfig` and reading the repo's rules from the base
**Goal**: `lib/repo.ts` with pure `checkRepoConfig(json)` → `{ config } | { problems }` and `readRepoRules(view, base)` → `{ afterPush, qaRules }`; `nextDesign(view, world, base)` in `lib/build.ts` reads the rules before `startOrResume`, and `bin/factory.ts` calls it on every refresh of the base.
**Success Criteria**: unknown fields (any level), wrong types, a missing or empty `command`, and a `whenChanged` that is absolute or uses `..` are problems; every error names `factory/config.json` and the branch; invalid JSON is an error; no files gives no after-push and no QA rules; a bad config stops `build` before a design is claimed; a rule changed on the base between designs applies to the next one.
**Tests**: `test/repo.test.ts` (empty object, full object, unknown field top-level and nested, missing `command`, empty `command`, wrong types, `whenChanged` absolute or with `..`, file + branch in the error, invalid JSON, no files, `qa-rules.md` read); `nextDesign` reads the rules again for each design and claims nothing when the config is bad; `test/cli.test.ts`: `factory build` with a bad `factory/config.json` on the base exits 1 naming file, branch and field, with no claim.
**Status**: Complete

## Stage 3: The QA-rules block in five prompts
**Goal**: `{{qa_rules}}` in `implement.md`, `finish.md`, `gate-break.md`, `gate-fix.md`, `review-fix.md`, filled by `qaRulesBlock(text, base)` with a block headed "This repo's QA rules (`factory/qa-rules.md` on `<base>`)", or nothing. `implement.md` step 5 becomes "Record whatever UX evidence this repo's QA rules ask for."; the `gate-break.md` rule sentence names "its QA rules below" and loses the `qa/ux/` sentence. `gate-excess.md` and `review-plan.md` are unchanged.
**Success Criteria**: with rules, their text is in all five prompts and not in the excess audit; without, no block; the worktree's own `factory/qa-rules.md` is never used; `qa/ux/`, "on staging", `.qa-artifacts` appear nowhere in `prompts/`.
**Tests**: extend `test/build.test.ts`: rules reach implement, finish, gate-break, gate-fix and review-fix prompts; absent with no rules; a `qa-rules.md` written into the worktree is not used.
**Status**: Complete

## Stage 4: The after-push command
**Goal**: `Workshop.afterPush(worktree, command)` runs `sh -c` in the worktree with the bot's `GH_TOKEN` and a 30-minute timeout, throwing with the command's last output on failure; `fingerprint(worktree, glob)` hashes sorted relative path + contents of matched files (`fs.globSync`), `null` when nothing matches; `watchPr` runs the step once per pass right after the PR is read as open. `publishEvidence` and `evidenceStamp` are deleted. `PrReport.afterPushStamp?: string`.
**Success Criteria**: as "After-push command" in the spec: heads must match, else the pass waits and does nothing else; runs when the stamp is absent (not when empty), or when `whenChanged` matches files whose fingerprint differs; stamp taken after the command; `{pr}` replaced; failure ends `needs attention` with the output, posting nothing, requesting no re-review, merging nothing; the next build retries.
**Tests**: extend `test/build.test.ts`: runs once when the PR opens; with `whenChanged`, again only after a matched file changes, not for unmatched files; without it never again, including with a stored empty stamp; a command writing into the matched files is not rerun; no matching files neither runs nor clears the stamp; failure blocks replies, re-review and merge, and the next build retries and carries on; differing heads post nothing and do not merge. `realWorkshop.afterPush`: runs in the worktree with the bot token, failure carries the last output.
**Status**: Complete

## Stage 5: README note on `factory/`
**Goal**: a short section on the repo's `factory/` folder: designs, `config.json` with an example, `qa-rules.md`, and that the after-push command runs repo code with the bot's token so the owner must trust it.
**Success Criteria**: README matches the spec's folder section; acceptance greps clean.
**Tests**: grep checks.
**Status**: Complete

## Checklist: every PR-2 row and test bullet mapped

| Item | Stage |
|---|---|
| Parity: designs in `designs/ready`, `designs/done` → `factory/…` | 1 |
| Parity: `make ux-evidence-publish PR=<n>` on PR open, bot token → `afterPush.command` | 4 |
| Parity: publish again when `.qa-artifacts/*/result.json` changed → `afterPush.whenChanged` | 4 |
| Parity: `implement.md` step 5 Playola wording → `qa-rules.md` | 3 |
| Parity: `gate-break.md` `qa/ux/` finding → `qa-rules.md` | 3 |
| Hardcoded: `designs/ready`/`designs/done` in code, PR body, usage, skill, prompts | 1 |
| Hardcoded: `make ux-evidence-publish` / `evidenceStamp` → `afterPush`; both methods deleted | 4 |
| Hardcoded: `implement.md` step 5, `gate-break.md` sentence → QA-rules block | 3 |
| Repo folder: `config.json`, `qa-rules.md`, read from `baseView` per design, how qa-rules reaches agents | 2, 3 |
| Validation: `checkRepoConfig`; command table repo-files column (`build` only) | 2 |
| After-push command, in full | 4 |
| README note (trust the command) | 5 |
| Tests: `checkRepoConfig` | 2 |
| Tests: Repo folder (found in `factory/ready`; read from base not worktree; no files; moved design keeps plan) | 1, 2, 3, 4 |
| Tests: `qa-rules.md` in all five prompts; absent with no file | 3 |
| Tests: After-push (all bullets) | 4 |
| Tests: read again for each design | 2 |
