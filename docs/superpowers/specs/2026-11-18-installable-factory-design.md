# Make the factory installable by anyone

## Intent

The factory works only for Brian and Playola: the owner, bot account, review bot, base branch, models, an
after-PR step, the UX-evidence rules in the prompts and parts of the `design-feature` skill are built in. A few
friends should be able to clone this repo, run `./install.sh` and `factory init`, and use it on their own GitHub
repos. Nothing should name Playola or Brian except as an example.

Rules split by whose they are. What belongs to a person and a computer goes in one settings file. What belongs to
a repo (its after-push command, QA rules and design rules) lives in that repo, in the `factory/` folder that also
holds its designs. What is true for everyone stays in this repo's code, prompts and skill.

Audience: friends, not the public. That sets the bar: clear setup and errors, but no plugin system and no
support for every review bot or design tool.

## Goals

- One settings file per computer, written by `factory init`, which most people never edit by hand.
- Every Brian/Playola value is in Brian's settings file, in a Playola repo's `factory/` folder, or gone.
- A missing or bad setting or repo config fails before any work starts, naming the field and what it expects.
- Brian keeps today's behaviour, step for step (see Playola parity).

## Non-goals

- Running several repos from one `factory build` (one terminal per repo already works; see Parallelism).
- Review bots other than Greptile, or making Greptile mandatory.
- A plugin interface for review bots. It waits until a second review bot is really needed.
- Letting Codex write and Claude review (the roles stay fixed).
- A template for setting up UX evidence in a repo.
- Renaming the tool. It stays `factory`; only its two folders move (see Names).

## Anti-goals

- Settings that can be wrong silently: an unknown or misspelt field is an error, not ignored.
- Secrets in the settings file or the repo folder.
- Any runtime dependency, or anything to `npm install`.
- A rule that is, even for one build, in neither its old place nor its new one.

## Constraints

- Node 24, zero dependencies, tests run with `node --test`. Settings are JSON for that reason.
- The factory needs two GitHub accounts: the **owner**, whose approval merges a PR, and a separate **bot** that
  writes commits, opens PRs and replies. GitHub won't let anyone approve their own PR, and the review loop tells
  "the owner asked for this" from "I already replied" only by which account wrote it. So one account can't do
  both, and the factory refuses `bot == owner` (compared without regard to case).
- The bot's token comes from `gh auth token --user <bot>`, as today; the bot must be signed in to `gh`.
- PRs for this work go straight to `main`. This repo has no `develop`; nothing is deployed, and friends install
  from `main`. Each PR must leave the factory working.

## Approaches considered

1. **Load and check the settings and the repo's config once in `bin/factory.ts`, then pass only what each part
   needs** (chosen). The CLI turns them into small values: the owner and bot identities, optional Greptile
   settings, optional models, the after-push command and the repo's QA rules. `realWorkshop`, `watchPr` and
   `runAgent` receive those values as arguments. They are testable with plain objects, and none of them knows
   either file's layout.
2. **One settings object every module imports.** This is less plumbing, but it is a hidden global. Tests would
   have to fake the file, and every module would depend on the whole layout. Rejected.
3. **Environment variables.** No file to write, but nowhere for `factory init` to save answers. Already ruled
   out in favour of one JSON file.

The owner handed the "how" to me; I chose approach 1. Codex reviewed the plan as architect, and its main
corrections are folded in below: combine the settings and consumer PRs, and make the after-push step retry after
a failure. (Its third, keying repos by GitHub name, no longer applies: per-repo values now live in the repo.)

## Names

The tool keeps the name `factory`. Factory.ai's Droid CLI uses `~/.factory/` (including
`~/.factory/settings.json`) and `<repo>/.factory/`
([Droid settings](https://docs.factory.ai/cli/configuration/settings),
[hierarchical settings](https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control)), so this tool
uses neither:

- **On the computer: `~/.config/factory/`** instead of `~/.factory/`. It holds the settings file and all build
  state, as `~/.factory/` does today, and `FACTORY_HOME` still overrides it. Droid doesn't use `~/.config/`. One
  small unrelated tool also called factory keeps a `config.json` there
  ([vilaca/factory](https://vilaca.github.io/factory/docs/configuration)); no file name overlaps, and anyone
  running both can set `FACTORY_HOME`.
- **In a repo: `factory/`** (no dot) instead of `designs/`. It holds the designs and the repo's rules. Neither
  Playola repo has any path named `factory` on `develop` or `feature/recorded-shows`, and no common tool claims a
  top-level `factory/`.

## The settings file

`$FACTORY_HOME/settings.json`, where `FACTORY_HOME` defaults to `~/.config/factory`. It holds only what belongs to
a person and a computer.

```json
{
  "owner": "briankeane",
  "bot": { "login": "marge-watson", "name": "Marge", "email": "263082108+marge-watson@users.noreply.github.com" },
  "greptile": { "reReviewBelow": 4 },
  "models": { "claude": "opus", "codex": "gpt-6-astra" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `owner` | yes | GitHub login whose approval merges a PR |
| `bot.login` | yes | GitHub login that writes commits, opens PRs and replies; signed in to `gh`; not the owner |
| `bot.name`, `bot.email` | yes | git author name and email for the bot's commits (`factory init` fills these in) |
| `greptile` | no | present means Greptile reviews this person's repos |
| `greptile.reReviewBelow` | no, default 4 | integer 1–5: after a fix is pushed, ask Greptile to review again when its last score was below this |
| `models.claude`, `models.codex` | no | model passed to that CLI; when absent, no model flag is passed and the CLI's own default applies |

Choices made here, each my call and open to correction:

- **`greptile` instead of a general `reviewBot`.** Its check name, `Confidence Score: N/5` and its
  "review again" comment are all specific to Greptile, so a general-looking `login` field would promise more
  than it delivers. Greptile's account (`greptile-apps`) is the same for everyone, so it stays in the code.
  Comments from any other reviewer, human or bot, are still answered like any other review thread.
- **No default model names.** `opus` and `gpt-6-astra` are verified only on Brian's accounts. Passing no flag
  is the one choice that works for everyone.

## The repo's `factory/` folder

Today's `designs/` folder becomes `factory/`, and it gains three optional files:

```text
<repo>/factory/
  config.json       the after-push command
  qa-rules.md       the repo's evidence and QA rules, pasted into the agents' prompts
  design-rules.md   the repo's design rules, read by the design-feature skill
  ready/<NNN>-<name>/
  done/<NNN>-<name>/
```

A repo with none of the three files works on the defaults: no after-push command and no extra QA or design
rules. Moving a design folder doesn't undo its finished plan: the finish seal hashes each file's path inside its
own design folder (`lib/readiness.ts:17-23`), not its path in the repo.

**`config.json`** has one field:

```json
{ "afterPush": { "command": "make ux-evidence-publish PR={pr}", "whenChanged": ".qa-artifacts/*/result.json" } }
```

| Field | Required | Meaning |
|---|---|---|
| `afterPush.command` | yes, when `afterPush` is present | shell command run in the PR's worktree once the PR is open; `{pr}` is replaced with the PR number |
| `afterPush.whenChanged` | no | glob of files in the worktree, relative and inside the repo (matched with Node's `fs.globSync`); the command runs again only when those files changed (see After-push command) |

It is checked as strictly as the settings file: invalid JSON, a wrong type or an unknown field is an error that
names the file, the branch it was read from and the field, e.g.
`factory/config.json on develop: afterpush is not a field (did you mean afterPush?)`. `build` stops before any
work.

**Where each file is read from.** All three are read from the base branch, never from the PR's own branch:

- `config.json` and `qa-rules.md`: the factory reads both from its own checkout of `origin/<base>` (`baseView`),
  where it already finds the designs. It reads them each time it refreshes that checkout, which is once per design
  (`bin/factory.ts:103`), not once per `factory build`. One build can run design after design for days, so a rule
  change merged into the base reaches the next design without a restart.
- `design-rules.md`: the `design-feature` skill reads it from the designer's checkout. The skill's set-up step
  already requires that checkout to be the base or freshly cut from it, so this is the base too.

That matches the owner's starting view for `config.json`: the command runs with the bot's token, so a PR must
not be able to change the command about to run on it. I disagree on `qa-rules.md` (see "Where I disagree"
below): it is read from the base too, not the worktree.

**How `qa-rules.md` reaches the agents.** Its text is pasted verbatim into the five prompts whose agents record,
check or redo evidence: `implement.md`, `finish.md`, `gate-break.md`, `gate-fix.md` and `review-fix.md`. In each
it is one block headed "This repo's QA rules (`factory/qa-rules.md` on `<base>`)", and the block is left out when
there is no file. The prompts keep only the general sentence:

- `implement.md` step 5 becomes "Record whatever UX evidence this repo's QA rules ask for."
- `gate-break.md`: "Breaking a written rule of this repo (its `CLAUDE.md`, `AGENTS.md`, the docs they point to,
  and its QA rules below) is a finding."
- `finish.md`, `gate-fix.md` and `review-fix.md` keep their existing general wording ("anything the rules require
  after a later change, such as re-recording stale evidence") and gain the block.

The Playola wording leaves these prompts and goes into Playola's `qa-rules.md` in the same PR (see Playola
parity).

**How `design-rules.md` reaches the skill.** The skill's set-up step reads it and follows it for the whole
conversation. The skill keeps the general workflow and the folder format, and says where the repo's file fills
in a step: where the backend lives, which docs to read, how screens are drawn and exported, and what to commit
with the folder.

## Validation

`lib/settings.ts` has a pure `checkSettings(json)` that collects every problem and returns either the settings
or the list. `loadSettings(home)` reads the file and throws one error listing all problems, then
`Run "factory init" to fix it.`. Problems include:

- the file is missing or isn't valid JSON (with the parse error)
- a required field is missing or is the wrong type, e.g.
  `owner is missing: the GitHub login whose approval merges a PR`
- an unknown field at any level, e.g. `reviewbot is not a setting (did you mean greptile?)`. The "did you mean"
  hint is optional polish.
- `bot.login` equal to `owner`
- `greptile.reReviewBelow` not an integer from 1 to 5

A pure `checkRepoConfig(json)` does the same for `factory/config.json`: unknown fields, wrong types, an empty
`command`, and a `whenChanged` that is absolute or leaves the repo.

Which commands need settings:

| Command | Settings | Repo's `factory/` files |
|---|---|---|
| `status`, `abandon` | not read | not read |
| `finalize` | optional: read only for `models`; a missing file is fine, but an invalid one is an error | not read |
| `build` | required, and checked before any work, together with: the bot's `gh` token works | `config.json` and `qa-rules.md` read from the base, checked before any work |

## How each hardcoded value goes away

| Today | Becomes |
|---|---|
| `AUTHOR` / `OWNER` (`lib/workshop.ts:96-99`) | `settings.bot` and `settings.owner`, passed into `realWorkshop` |
| `GREPTILE` constant, score parsing, `/greptile/i` failed-check filter, `@greptile review this` | only when `settings.greptile` is set. `PullRequestState.greptileScore` becomes `greptile: { score: number \| null } \| null`, where `null` means not in use, and a `null` score covers both "none posted yet" and "couldn't be read". Re-review is requested only for a parsed score below the threshold, never for a missing or unreadable one. |
| `RE_REVIEW_BELOW = 4` (`lib/review.ts:12`) | `settings.greptile.reReviewBelow` |
| `DEFAULT_MODEL` (`lib/agents.ts:9`) | `model?: string` on agent calls; `--model` / `-m` added only when set. `build`: Claude's model is `--model`, then `settings.models.claude`; Codex's is `settings.models.codex` (no new flag). `finalize`: the reviewer is the vendor other than `--author`, and its model is `--reviewer-model`, then `settings.models[that vendor]`. Either way, with nothing set, no flag is passed. |
| `'develop'` default (`bin/factory.ts:94`) | `--base`, then the existing claim's base, then `gh repo view <id> --json defaultBranchRef`. GitHub is asked only when neither of the others gives a base, using the bot's token, since the bot must be able to reach the repo anyway. If that fails, the error names the repo and suggests `--base`. The claim is checked before asking GitHub, so renaming the default branch doesn't block a build in progress. An explicit `--base` that conflicts with the claim keeps today's error. |
| `~/.factory` default for `FACTORY_HOME` (`bin/factory.ts:34`) | `~/.config/factory` (see Names) |
| `designs/ready`, `designs/done` (`lib/design.ts`, `lib/readiness.ts`, `lib/workshop.ts`, the PR body in `lib/implement.ts`, usage text, the skill, and "anything under `designs/`" in `implement.md` and `finish.md`) | `factory/ready`, `factory/done`, `factory/` |
| usage text naming `marge-watson` and `develop` | says "the bot account" and "the repo's default branch" |
| `make ux-evidence-publish` and `evidenceStamp` / `.qa-artifacts` | `factory/config.json` `afterPush` (below); both evidence methods are deleted from `Workshop` |
| `implement.md` step 5 and the `gate-break.md` evidence sentence (`qa/ux/`, "on staging", video over screenshots) | Playola's `factory/qa-rules.md`, verbatim; the prompts keep the general sentence and the QA-rules block |
| prompts label every non-owner as `bot` and say "the others are review bots" | label `reviewer`, and "the others are other reviewers, people or bots". The stored field `forBots` keeps its name so existing saved reports still load. |
| Playola specifics in `skills/design-feature/SKILL.md` | Playola's `factory/design-rules.md`, verbatim (see Playola parity); the skill points at the file |
| skill fallback `node ~/playola/playola-skills/factory/bin/factory.ts` | removed; `install.sh` puts `factory` on the PATH, and the skill says to run it if `factory` is missing |
| test fixtures using `briankeane` / `marge-watson` | neutral logins such as `owner-login` / `bot-login` |

Logins are compared without regard to case wherever the review loop matches authors.

## After-push command

This replaces `publishEvidence`. It runs in **one place**: at the top of each `watchPr` pass, after reading the
PR's state from GitHub. Every way a new head can reach GitHub ends up there: opening the PR, a review-fix push,
a clean merge of the base branch, or the "mark design built" push on resume. So there is no list of call sites
to keep in step.

- **When it runs (owner's decision: option B).** It is considered only when `afterPush` is set and the
  worktree's head equals GitHub's head. When the heads differ, this pass defers all following review-loop effects:
  it posts no replies, requests no re-review, and cannot merge. A later pass may continue only after its worktree
  matches GitHub's head and the command has succeeded. With matching heads, it runs if either:
  - it has never succeeded on this PR: the PR report has **no** `afterPushStamp` field at all. An empty string is
    a stored stamp and means it has succeeded; the test is "absent", never "empty", or a repo without
    `whenChanged` would run its command on every pass; or
  - `whenChanged` is set, it matches at least one file, and its fingerprint differs from `afterPushStamp`.

  Without `whenChanged`, it runs once and never again. Why: Playola's publish posts a new PR comment every time
  and fails when the evidence is stale, so running on every commit would post duplicates and could stop a build
  after a base merge. Option A, running on every new head, was rejected for that reason.
- **Order.** It runs right after the PR is read as open: before waiting on checks and before the merge, so an
  approved PR never merges ahead of its command.
- **The fingerprint** of `whenChanged` is a hash of the relative path and contents of every file the glob matches,
  in sorted order; the files may be git-ignored. A narrow glob keeps it cheap: Playola's
  `.qa-artifacts/*/result.json` matches small JSON files, never the videos. That is exactly what today's
  `evidenceStamp` compares, so a recording that dies partway (videos written, no new `result.json`) triggers
  nothing, as today. The fingerprint is taken **after the command finishes**, so a command that writes into the
  matched files doesn't look like a change on the next pass.
- **No matching files** (the folder is missing or empty) counts as unchanged: the command doesn't run, and the
  stored stamp is kept. That is the case when the worktree was rebuilt (a fresh checkout has no git-ignored
  files), and there is nothing new to publish; the evidence already posted stays on the PR. When an agent records
  evidence again, the glob matches files whose fingerprint differs, and the command runs. The very first run is
  the exception: it happens whether or not anything matches, as `make ux-evidence-publish` does today when the PR
  opens.
- It runs as `sh -c <command>` with `{pr}` replaced by the PR number (always a number). The working directory
  is the worktree, and the environment includes the bot's `GH_TOKEN`, as `make ux-evidence-publish` gets today
  (its target reads `.qa-artifacts` from the folder it runs in). It has a 30-minute timeout.
- **Success** stores the fingerprint as `afterPushStamp` in the PR report (an empty string when there is no
  `whenChanged` or nothing matches). The field is optional, so reports saved before this change still load.
- **Failure** stores nothing. The PR ends as `needs attention`, showing the command's last output. Nothing more is
  posted, no re-review is requested, and no merge is attempted. The next `factory build` sees no new stamp and
  runs it again, so the command must be safe to run twice. If the matched files have vanished by then, there is
  nothing left to publish, and it doesn't run.
- The README says plainly that this command runs repo code with the bot's token, so it must be something the
  owner trusts. Reading it from the base branch means only merged code can change it; the PR's own code already
  runs in that worktree for every test and check.

## `factory init`

Interactive with `node:readline/promises`. The question-asker and the `gh` calls are passed in, so tests drive
it with scripted answers. If a valid settings file exists, its values are the defaults and the result overwrites
it (after showing the file path). If a file exists at that path but isn't valid factory settings, `init` names the
file and stops without touching it, so it can never overwrite another tool's file; the message says to fix or
move the file, or to set `FACTORY_HOME`. Questions:

1. **Owner login**: defaults to the account `gh` is currently signed in as (`gh api user -q .login`).
2. **Bot login**: asked directly. Then it checks `gh auth token --user <bot>` works. If that fails, it prints
   the steps to sign the bot in and stops without writing anything. It refuses the owner's login.
3. **Bot name**: defaults to the login. The email is worked out from `gh api users/<bot>` as
   `<id>+<login>@users.noreply.github.com`, without asking.
4. **Does Greptile review your repos?** (y/N). If yes, it asks for the score below which to request another
   review (default 4).
5. **Claude model** and **Codex model**: blank means "use the CLI's default".

`init` then writes the file through the same `checkSettings`, so it can't write a file that `build` would reject.
It doesn't touch repos: a repo's `factory/` files are committed to that repo by hand, as the README shows.

## Parallelism

All build state is per repo: the lock, claim, worktrees and PR reports. Only `events.jsonl` is shared, through
small appends. One `factory build <repo>` per terminal is the supported way, and the README says so. Not in
scope: `factory build --all`, and fixing the non-atomic build lock.

## `design-feature` skill

It stays one opinionated workflow and is documented as such. Design folders move from `designs/ready/` to
`factory/ready/` throughout. Each Playola specific moves, word for word, into Playola's
`factory/design-rules.md` (below), and the skill says where the repo's file fills in the step:

- **Set up (step 1):** after the fresh-base check, read `factory/design-rules.md` if the repo has one, and follow
  it for the rest of the conversation. The "Backend" and "Canvas" bullets become: "Backend: if the models and
  endpoints this design touches live in another repo, `design-rules.md` says where; read them there and record
  that repo's SHA in `Design.md`." and "Screens: drawn the way `design-rules.md` says. Without one, ask the owner
  how they will supply each screen as a PNG. Never skip the screens silently."
- **Read what exists (step 3):** "the docs `design-rules.md` names, the current screens, and the code those
  screens run on".
- **Screens (step 4):** "New frames follow any layout rules in `design-rules.md`; reuse existing components."
- **Contract and models (step 5):** "Backend conventions: those in `design-rules.md` and the backend's own docs;
  one source of truth for anything that can change." ("One source of truth" stays; it is general.)
- **Export (step 7):** "Save every approved screen as a PNG in `screenshots/`, named `<screen>--<state>.png`, the
  way `design-rules.md` says."
- **Ship (step 10):** "commit it, with any design file `design-rules.md` says to commit".
- Fallback path (line 21): "If `factory` is not on the PATH, run `./install.sh` from the factory repo."
- Base branch example (step 1): "a feature branch such as `feature/recorded-shows`" becomes "a feature branch
  such as `feature/<name>`". "Never `main` in a repo whose default is `develop`" stays; it is general.
- Plan (step 8): "every PR costs a paid review" becomes "every PR costs a full review", which is true with or
  without Greptile (the gate's Codex passes run on every PR).

## Playola parity

Every Playola- or Brian-specific behaviour that leaves this repo, where it lands, and the PR that moves it.
Found by reading `bin/`, `lib/`, `prompts/` and `skills/`.

| Behaviour today | Where it lives today | New home | PR |
|---|---|---|---|
| Bot `marge-watson` / `Marge` / its noreply email writes commits, pushes, opens PRs, replies | `lib/workshop.ts` `AUTHOR` | `settings.json` `bot` | 1 |
| Bot token from `gh auth token --user marge-watson` | `lib/workshop.ts` | `settings.json` `bot.login` | 1 |
| `briankeane`'s approval merges; his comments are owner requests | `lib/workshop.ts` `OWNER` | `settings.json` `owner` | 1 |
| Greptile score parsing, hiding its failed check, `@greptile review this` | `lib/workshop.ts` | stays in code, on because `settings.json` has `greptile` | 1 |
| Re-review when the score is below 4 | `lib/review.ts` `RE_REVIEW_BELOW` | `settings.json` `greptile.reReviewBelow` | 1 |
| Claude runs as `opus`, Codex as `gpt-6-astra` | `lib/agents.ts` `DEFAULT_MODEL` | `settings.json` `models` | 1 |
| PRs go into `develop` by default | `bin/factory.ts` | GitHub's default branch, which is `develop` in both Playola repos | 1 |
| PRs go into `feature/recorded-shows` | `--base` on the first `factory build`, then the claim | unchanged | — |
| Usage text naming `marge-watson` and `develop` | `bin/factory.ts` | generic wording | 1 |
| Build state in `~/.factory` | `bin/factory.ts` | `~/.config/factory` | 1 |
| Designs in `designs/ready`, `designs/done` | code, skill, prompts | `factory/ready`, `factory/done` | 2 |
| `make ux-evidence-publish PR=<n>` when the PR opens, with the bot's token, in any repo whose Makefile has the target | `lib/workshop.ts` `publishEvidence` | `factory/config.json` `afterPush.command` | 2 |
| Publish again after a fix when `.qa-artifacts/*/result.json` changed | `lib/workshop.ts` `evidenceStamp`, `lib/review.ts` | `factory/config.json` `afterPush.whenChanged` (the same glob) | 2 |
| Video (`functional`) over screenshots (`visual`) for "Done when" items, full flow on staging, staging data, name what the recording misses | `prompts/implement.md` step 5 | `factory/qa-rules.md` | 2 |
| Gate finding: `qa/ux/` evidence that is screenshots, or whose flow stops early | `prompts/gate-break.md` | `factory/qa-rules.md` | 2 |
| Backend in the playola monorepo at `/Users/brian/playola/playola`; record its `develop` SHA | skill step 1 | `factory/design-rules.md` | 3 |
| Canvas `design/*.pen` through the pencil MCP only; Pen.app must be running | skill step 1 | `factory/design-rules.md` | 3 |
| Read `docs/context/`, the backend's `MODEL.md` and `ENDPOINTS.md` | skill step 3 | `factory/design-rules.md` | 3 |
| New frames in a labelled zone, following `design/DESIGN_STATUS.md` | skill step 4 | `factory/design-rules.md` | 3 |
| REST resources, `PUT` never `PATCH` | skill step 5 | `factory/design-rules.md` | 3 |
| Export with pencil `Export`, absolute path, rename to `<screen>--<state>.png` | skill step 7 | `factory/design-rules.md` | 3 |
| Commit the canvas file with the design folder | skill step 10 | `factory/design-rules.md` | 3 |
| Skill's fallback path to `~/playola/playola-skills/factory` | skill line 21 | removed | 3 |
| Skill's base-branch example `feature/recorded-shows` | skill step 1 | neutral `feature/<name>` | 3 |
| "every PR costs a paid review" (assumes Greptile) | skill step 8 | "every PR costs a full review" | 3 |
| `~/.local/bin/factory`, the skill links, and the `CLAUDE.md` / `AGENTS.md` paths | this computer | cutover checklist | — |

Staying in the factory because they are general: the `feature:` / `bugfix:` / `chore:` title rule in plans, no
`Co-Authored-By` lines, the design folder format and `## Done when`, and "one source of truth".

Publishing again tracks today's behaviour exactly: Playola's `whenChanged` is the same `result.json` glob
`evidenceStamp` reads. The one change is a fix: today, evidence re-recorded in a review round that then fails is
never published, because the comparison happens only inside that round; the stored stamp catches it on the next
pass.

**Brian's `~/.config/factory/settings.json`** (what `factory init` writes from his answers):

```json
{
  "owner": "briankeane",
  "bot": { "login": "marge-watson", "name": "Marge", "email": "263082108+marge-watson@users.noreply.github.com" },
  "greptile": { "reReviewBelow": 4 },
  "models": { "claude": "opus", "codex": "gpt-6-astra" }
}
```

**`playola-radio-ios` `factory/`**, on `develop` and on `feature/recorded-shows` (both are bases a build reads
from). On `feature/recorded-shows`, `git mv designs factory` first, so `designs/done/001-series-picker` and
`designs/ready/002-manage-series` become `factory/done/…` and `factory/ready/…`; `develop` has no `designs/`
folder yet. `playola-radio/playola` gets the same three files on `develop`: its Makefile has the same publish
target and `qa/ux/`, and today's skill text applies to both repos alike. Its `designs/in-progress/` belongs to a
different convention and stays where it is.

`factory/config.json`:

```json
{ "afterPush": { "command": "make ux-evidence-publish PR={pr}", "whenChanged": ".qa-artifacts/*/result.json" } }
```

`ux-evidence-publish` exists in the Makefile on all three bases (ios `develop`, ios `feature/recorded-shows`,
playola `develop`). That matters: today a missing target is skipped silently, and after PR 2 it fails the PR.

`factory/qa-rules.md`:

```markdown
Where the repo's rules call for UX evidence: a PR that delivers "Done when" items records a `functional` case (video) whose flow carries those items out from start to finish on staging, including the taps that save. `visual` (screenshots) is only for a restyle of a screen that already works. Make whatever staging data the flow needs to show a realistic screen. Name in your summary any item the recording does not show, and why.

A review finding: UX evidence (the cases under `qa/ux/`) that is screenshots where this PR delivers "Done when" items, or whose flow stops before carrying those items out.
```

`factory/design-rules.md`:

```markdown
- **Backend:** models and endpoints live in the playola monorepo. From another repo, read them at `/Users/brian/playola/playola` and record its `develop` SHA in `Design.md`.
- **Canvas:** the repo's `design/*.pen`, read and changed only through the pencil MCP, never with file tools. `get_app_state` failing means Pen.app is not running: ask the owner to open it. Never skip the screens silently.
- **Read what exists:** `docs/context/` feature docs, the backend's `MODEL.md` and `ENDPOINTS.md` files, and the current screens on the canvas.
- **New frames** go in a labelled zone on the canvas, following `design/DESIGN_STATUS.md`.
- **Backend conventions:** REST resources, `PUT` never `PATCH`.
- **Export** every approved frame as PNG into `screenshots/` (pencil `Export`, absolute path, then rename each file to `<screen>--<state>.png`).
- **Ship:** commit the canvas file with the design folder.
```

**Order.** The new files do nothing until the factory reads them, but the folder move can't wait: today's factory
can't find designs in `factory/`, and factory PR 2 can't find them in `designs/`. So factory PR 2 and the Playola
PRs (the move plus all three files at once) merge back to back. `design-rules.md` then sits unread until factory
PR 3, which removes the same text from the skill. No build ever has a rule in neither place.

**When the move may happen.** "Nothing running" is not enough. A stopped build still has a claim, and maybe an open
PR whose worktree holds `designs/ready/<design>`: under PR 2's code, `planIsIntact` and `markDesignBuilt` look in
`factory/ready`, so that PR would end as "design folder or its plan was changed". An open `design:` PR would merge
its folder into `designs/`, where the new factory never looks. And a PR report saved before PR 2 has no
`afterPushStamp`, so its evidence would be published a second time. So the condition is: **no design in progress
(`builds/` is empty), no open factory PR, and no open `design:` PR on any base being moved.** That is true today.
For `playola-radio-ios`, it means doing it before `002-manage-series` starts building or after its last PR merges.

## Cutover checklist

Not a PR. `~/playola/factory` (a clone of this repo at `main`) is identical to the copy in
`playola-radio/ai-skills`, so the first two steps change nothing in behaviour and can run now.

**Now**

- [ ] `git -C ~/playola/factory pull`, then `~/playola/factory/install.sh`. This repoints
      `~/.local/bin/factory` and both `design-feature` skill links (`~/.claude/skills`, `~/.codex/skills`) at
      this repo; `install.sh` refreshes existing links.
- [ ] In one edit, change `~/.claude/CLAUDE.md` lines 286-287 and `~/.codex/AGENTS.md` lines 355-356 to
      `factory status <repo>` and `~/.claude/skills/design-feature/SKILL.md`, keeping the two files mirrored.
- [ ] Open a PR in `playola-radio/ai-skills` deleting `factory/` and `design-feature/`.

**After factory PR 1 merges** (only with no design in progress: `~/.factory/builds/` is empty)

- [ ] Pull. Then remove the old git worktrees properly, rather than moving them: for each folder under
      `~/.factory/worktrees/*/` that is a git worktree (today `playola-radio__playola-radio-ios/base` and
      `…/factory__001-series-picker__pr-1`), run `git worktree remove <folder>` from its repo. A moved worktree is
      no longer a checkout, and `baseView` (`lib/workshop.ts:126`) would fail running `git checkout` in it; PR
      reports also store absolute worktree paths, which is why a design in progress can't be moved at all.
- [ ] `mkdir -p ~/.config/factory` and move what is left (`events.jsonl`, `runs/`, `archive/`) into it. The
      factory recreates `base` on the next build.
- [ ] Run `factory init` once before the next build.

**When factory PR 2 merges** (back to back with the Playola PRs, under the condition in "When the move may
happen")

- [ ] In one edit, change `designs/ready/<NNN>-<kebab-name>/` to `factory/ready/<NNN>-<kebab-name>/` in
      `~/.claude/CLAUDE.md` line 277 and `~/.codex/AGENTS.md` line 346, keeping the two files mirrored.

## Docs and license

- README: prerequisites (Node 24+, git, `gh`, `claude`, `codex`, two GitHub accounts, optionally Greptile and
  pen.dev); clone with `<your fork or this repo's URL>` instead of `playola-radio/factory`; `./install.sh`;
  `factory init`; the repo's `factory/` folder with an example of each optional file; designing a feature;
  `factory build`; the settings reference above; one terminal per repo; don't change `owner`/`bot` while a build
  is in progress (abandon it first).
- `LICENSE`: MIT.

## PRs (each to `main`, each leaving the factory working)

1. **`feature: let each person set up the factory with their own GitHub accounts`**: `lib/settings.ts`,
   `factory init` (including its refusal to overwrite a file that isn't factory settings), and owner, bot,
   Greptile and models read from settings; `FACTORY_HOME` defaults to `~/.config/factory`; the base defaults to
   GitHub's default branch. It also includes the optional model flag, `reviewer` labels in prompts, neutral test
   fixtures, and the README's setup section. Check: with Brian's settings, the spawned CLI arguments still carry
   both `opus` and `gpt-6-astra`.
2. **`feature: keep each repo's designs and its own build rules in one factory folder`**: designs move from
   `designs/` to `factory/` everywhere in the code, prompts and skill; reads `factory/config.json` and
   `qa-rules.md` from the base; `afterPush` with `whenChanged` and retry; the QA-rules block in the five prompts;
   and, in the same PR, deletes the evidence methods and moves the Playola wording out of `implement.md` and
   `gate-break.md`. Merges back to back with the Playola PRs, only when no design is in progress and no factory
   or `design:` PR is open on a base being moved.
3. **`feature: let each repo set its own design rules, with a setup guide and license`**: the skill reads
   `factory/design-rules.md` and loses its Playola specifics in the same PR, the full README walkthrough, and the
   MIT `LICENSE`.

Outside this repo, with PR 2: one PR per Playola base branch (`develop` in both repos, and
`feature/recorded-shows` in `playola-radio-ios`) that moves `designs/` to `factory/` where it exists and adds
the three files.

## Tests

- `checkSettings`: a valid minimal file, a valid full file, each required field missing, wrong types, unknown
  fields at top level and nested, `bot == owner` in different cases, `reReviewBelow` out of range, and several
  problems reported together.
- `loadSettings`: missing file, bad JSON.
- `checkRepoConfig`: empty object, full object, unknown field, missing `command`, `whenChanged` absolute or with
  `..`; the error names the file and branch.
- Repo folder: designs are found in `factory/ready`; `config.json` and `qa-rules.md` are read from the base, so an
  edit in the PR's worktree is not used; with none of the three files, there is no after-push and no QA block; a
  design moved from `designs/ready` to `factory/ready` keeps its finished plan.
- `qa-rules.md`: its text appears in all five prompts; with no file, the block is absent.
- `factory init`: scripted answers write the expected file; a failing bot token writes nothing; bot equal to
  owner is refused; existing values are offered as defaults; a file that isn't factory settings is left untouched
  and named in the error.
- Models: the spawned arguments for both CLIs have no model flag when none is set, and the right one when set;
  Brian's settings give `opus` and `gpt-6-astra`.
- Base: flag > claim > GitHub default; a claim survives a changed GitHub default.
- Review loop: no Greptile, meaning no re-review and a check named "greptile" isn't hidden; Greptile with a
  score below / at / above the threshold, or missing; a human non-owner thread is answered as a reviewer.
- After-push: runs once when the PR opens; with `whenChanged`, runs again only after a matched file's contents
  change, and not when only unmatched files change; without it, never again, including when the stored stamp is
  an empty string; a command that writes into the matched files isn't rerun; no matching files neither runs it
  nor clears the stamp; a failure leaves `needs attention` with no replies posted, blocks re-review and merge,
  and the next run retries and then carries on; when the worktree's head differs from GitHub's, the pass posts
  nothing and doesn't merge.
- `config.json` and `qa-rules.md` are read again for each design, so a change merged into the base during a long
  build applies to the next design.

## Where I disagree with the brief

- **No `base` in `config.json`.** The repo's config is read from the base branch, so it can't also name the base:
  the factory would need the base to find the file that names the base. Today the base is `--base` or `develop`,
  and the claim remembers it. After PR 1 it's `--base`, the claim, or GitHub's default (`develop` for Playola),
  so no step gets harder: `feature/recorded-shows` still takes `--base` once per design, as now.
- **`qa-rules.md` read from the base, not the worktree.** In the worktree, the agents being judged by these rules
  can edit them before the gate reads them, and a PR could loosen its own gate. Reading from the base costs
  nothing. A PR that changes `qa-rules.md` takes effect once merged, like `config.json`.
- **Five prompts get the QA rules, not three.** Besides implement, gate-break and review-fix: `finish.md` (it
  resumes a PR whose evidence step was often the one that blocked) and `gate-fix.md` (it re-records stale
  evidence after fixing gate findings). `gate-excess.md` and the plan review don't touch evidence and don't get
  them.
- **One word-level change to the moved gate sentence.** It starts "So is UX evidence…", which leans on the
  sentence before it in `gate-break.md`. In `qa-rules.md` it reads "A review finding: UX evidence…"; the rest is
  unchanged. `implement.md` step 5 moves exactly as it is.

## Left to the builder

Exact wording of messages, prompt blocks and README prose; how `checkSettings` and `checkRepoConfig` are
structured internally; whether `factory init` lives in `bin/factory.ts` or `lib/init.ts`.
