# Installable factory, PR 3: design rules, setup guide and license

Spec: `docs/superpowers/specs/2026-11-18-installable-factory-design.md`. The last of three PRs. The
`design-feature` skill reads the repo's `factory/design-rules.md` and loses its Playola specifics; the README becomes
the full walkthrough; the repo gets an MIT `LICENSE`. No CLI behaviour changes: the CLI never reads `design-rules.md`
(the skill reads it from the designer's checkout). The plan table's `Hard` column (`lib/plan.ts`, the skill's plan
format, `test/plan.test.ts`) is left alone. There is no changelog in this repo.

## Stage 1: The skill reads `factory/design-rules.md`
**Goal**: `skills/design-feature/SKILL.md` set-up step reads `factory/design-rules.md` if the repo has one and follows it for the whole conversation; the spec's wording for steps 1 (Backend, Screens), 3, 4, 5, 7 and 10 is used as given; the fallback line becomes "If `factory` is not on the PATH, run `./install.sh` from the factory repo."; `feature/recorded-shows` becomes `feature/<name>`; "every PR costs a paid review" becomes "every PR costs a full review". Nothing else in the skill changes.
**Success Criteria**: `grep -rniE "playola|pencil|\.pen|PATCH|recorded-shows|paid review|playola-skills|DESIGN_STATUS|MODEL\.md|ENDPOINTS\.md|docs/context" skills/` finds nothing; every removed sentence is present in Playola's `design-rules.md` (mapping below); `git diff origin/main -- lib/plan.ts test/plan.test.ts` is empty and the skill's plan format still has the `Hard` column.
**Tests**: the acceptance grep and the diff check; `node --test` still passes (no test pins skill text).
**Status**: Complete

## Stage 2: README walkthrough
**Goal**: the README covers, in order: prerequisites (Node 24+, `git`, `gh`, `claude`, `codex`, two GitHub accounts, optionally Greptile and pen.dev), clone with a placeholder URL, `./install.sh`, `factory init`, the settings reference, the repo's `factory/` folder with an example of each optional file (`config.json`, `qa-rules.md`, `design-rules.md`), designing a feature, `factory build`, one terminal per repo, and not changing `owner`/`bot` mid-build (abandon first). The intro note that says the design rules are built into the skill is removed.
**Success Criteria**: README has no `/Users/brian`, no `playola-radio/factory` clone URL, and no Playola specifics beyond what an example needs (none); the spec's "Docs and license" README bullet is covered item by item.
**Tests**: grep checks on the README.
**Status**: Complete

## Stage 3: `LICENSE`
**Goal**: an MIT `LICENSE` at the repo root. The spec names no copyright holder, so "Brian Keane" and the current year (2026).
**Success Criteria**: `LICENSE` exists and is the standard MIT text.
**Tests**: file check.
**Status**: Complete

## Checklist: every PR-3 row, skill step and docs bullet mapped

| Item | Stage |
|---|---|
| Parity: backend in the playola monorepo, record its `develop` SHA (skill step 1) | 1 |
| Parity: canvas `design/*.pen` through the pencil MCP; Pen.app running (skill step 1) | 1 |
| Parity: read `docs/context/`, `MODEL.md`, `ENDPOINTS.md` (skill step 3) | 1 |
| Parity: new frames in a labelled zone, `design/DESIGN_STATUS.md` (skill step 4) | 1 |
| Parity: REST resources, `PUT` never `PATCH` (skill step 5) | 1 |
| Parity: export with pencil `Export`, absolute path, rename (skill step 7) | 1 |
| Parity: commit the canvas file with the design folder (skill step 10) | 1 |
| Parity: fallback path `~/playola/playola-skills/factory` removed (skill line 21) | 1 |
| Parity: base-branch example `feature/recorded-shows` → `feature/<name>` | 1 |
| Parity: "every PR costs a paid review" → "a full review" | 1 |
| Hardcoded: Playola specifics in the skill → `factory/design-rules.md`; skill points at the file | 1 |
| Hardcoded: skill fallback path removed; says to run `./install.sh` | 1 |
| `design-rules.md` in the repo's `factory/` folder, and how it reaches the skill | 1, 2 |
| Skill step 1: read `design-rules.md`, follow it; "Backend" and "Screens" bullets | 1 |
| Skill step 3, 4, 5, 7, 10 wording | 1 |
| Skill: fallback line; base-branch example; "full review" | 1 |
| Docs: prerequisites | 2 |
| Docs: clone with a placeholder URL | 2 |
| Docs: `./install.sh` | 2 |
| Docs: `factory init` | 2 |
| Docs: the `factory/` folder with an example of each optional file | 2 |
| Docs: designing a feature | 2 |
| Docs: `factory build` | 2 |
| Docs: the settings reference | 2 |
| Docs: one terminal per repo | 2 |
| Docs: don't change `owner`/`bot` mid-build | 2 |
| Docs: `LICENSE` MIT | 3 |
| Tests: none tied to PR 3 by the spec's "Tests" section | — |

### Removed skill text → Playola's `factory/design-rules.md`

| Removed from the skill | Now in `design-rules.md` |
|---|---|
| Step 1 "Backend: models and endpoints live in the playola monorepo. From another repo, read them at `/Users/brian/playola/playola` and record its `develop` SHA in `Design.md`." | `- **Backend:**` bullet, verbatim |
| Step 1 "Canvas: the repo's `design/*.pen`, read and changed only through the pencil MCP, … Never skip the screens silently." | `- **Canvas:**` bullet, verbatim (the skill keeps the general "never skip the screens silently" in its new Screens bullet) |
| Step 3 "`docs/context/` feature docs, the backend's `MODEL.md` and `ENDPOINTS.md` files, the current screens on the canvas" | `- **Read what exists:**` bullet |
| Step 4 "New frames go in a labelled zone on the canvas, following `design/DESIGN_STATUS.md` where the repo has one" | `- **New frames**` bullet ("reuse existing components" stays in the skill: general) |
| Step 5 "REST resources, `PUT` never `PATCH`" | `- **Backend conventions:**` bullet ("one source of truth" stays: general) |
| Step 7 "(pencil `Export`, absolute path, then rename each file to `<screen>--<state>.png`)" | `- **Export**` bullet (the `<screen>--<state>.png` name stays in the skill's folder tree) |
| Step 10 "with the canvas file" | `- **Ship:**` bullet |
| Line 21 fallback path, step 1 `feature/recorded-shows`, step 8 "paid review" | not Playola rules: replaced by the spec's neutral wording, nothing to move |

Nothing removed lacks a home in `design-rules.md`.
