# `factory build`: refuse to start when the disk is nearly full

Date: 2026-11-20. Status: approved (autonomous task; the single-PR spec was given in full).

## Intent

On 2026-11-20 a build on the Mac mini ran out of disk space and crashed with `ENOSPC` in the middle of a review
round, leaving an unpushed commit and unanswered review threads. The watcher's next attempts on the other repos
failed too (`ENOSPC: no space left on device, open '.../build.pid'`), and it paused every repo. One two-PR iOS
design uses about 45–50 GB.

A build should notice a nearly-full disk and refuse *before* it starts work, with a plain message, rather than
crash partway through an agent step and leave a mess behind.

## Goals

- Before `factory build` claims a design or starts any agent step (implement, a gate round, a review round),
  check free space on the volume holding the factory home (`$FACTORY_HOME`, default `~/.factory`). Below a
  floor, stop with a plain message saying how much is free and how much is needed, and exit 1.
- Default floor 20 GB, overridable with the `FACTORY_MIN_FREE_GB` environment variable (binary gigabytes,
  1024³ bytes). Documented in the README.
- A build with nothing to build still exits 0 on a full disk, so the watcher does not pause repos that have no
  work.
- Record an event in `events.jsonl` when a build is refused for space, so a later notifier can report it.

## Non-goals

- Changing the watcher (`lib/watch.ts`). A non-zero exit already pauses that repo until the watcher restarts; a
  low-disk refusal exits 1, so it pauses the repo and needs a watcher restart once space is freed. That is the
  existing, intended behaviour and is not touched here.
- Cleaning up disk, estimating a build's size, or choosing *which* design fits. The floor is a blunt safety
  stop, not a planner.
- Checking disk during the GitHub long-poll while a PR waits on the owner (no agent is running, no disk is being
  consumed).

## Anti-goals

- A build that crashes with `ENOSPC` partway through an agent step, leaving an unpushed commit and unanswered
  review threads.
- Pausing a repo that has no work just because the disk is full.

## How a build runs today (what this hooks into)

`factory build` acquires a `build.pid` lock, then loops: `startOrResume` claims the next ready design (or
resumes the one in progress), and `buildDesign` runs the agent steps for each PR — `implement`, then the gate
(`breakIt`/`auditExcess`/`fix`, up to three rounds), then the review loop (`answerReview`, up to three bot
rounds). The agent steps all go through the `Workshop`. `World` already bundles the build's contact with the
environment (`store`, `repoId`, `remoteBranches`, `now`) and is injected in tests.

## Approaches considered

1. **A `refused` `BuildReport` at claim time only.** Fits the existing `startOrResume` return shape, but only
   guards the claim — a resumed build (already in progress) would still crash mid-step — and prints JSON rather
   than a plain message. Rejected: it does not cover the agent steps the incident actually died in.
2. **A thrown `LowDiskError`, guarding the claim and every agent step (chosen).** One small guard,
   `ensureDiskSpace(world, design)`, called before the claim and at the start of each agent step. It records the
   refusal event and throws. The top-level `main().catch` already prints `error.message` plainly and sets exit
   1, so this gives the plain message and exit code for free and matches how the repo signals "cannot start".
3. **A watcher-level pre-check.** Rejected: the spec forbids touching the watcher, and the build is the only
   place that knows whether there is work to do (needed for the exit-0-when-empty rule).

## Design

- Add `freeSpace(): number` (bytes available on the factory volume) to the `World` interface, injected in tests.
  `realWorld` implements it with `fs.statfsSync` on the factory home (walking up to the nearest existing
  ancestor, since the home may not exist on a first run): `bavail * bsize`.
- `minFreeBytes(env = process.env)`: `FACTORY_MIN_FREE_GB` (default 20) × 1024³. A non-numeric or negative value
  is an error, read lazily only when a check actually runs, so a bad value never affects an empty repo.
- `LowDiskError`: message `Not enough disk space to build: X.X GB free on the factory volume, Y.Y GB needed.
  Free up space, then restart the build.`
- `ensureDiskSpace(world, design, env?)`: if `freeSpace() >= minFreeBytes()`, return; otherwise record a
  `build refused for space` event (`{ at, repo, design, type }`, as `lib/store.ts` records events) and throw
  `LowDiskError`.
- Call sites: `startOrResume` right before it claims a fresh design; `buildNextPr` before `workshop.implement`;
  `runGate` at the start of each round (before the break-it/excess passes); `watchPr` before each
  `answerReview` round. The nothing-to-build and all-PRs-merged paths return before any guard, so they stay
  exit 0.
- Add `'build refused for space'` to the `FactoryEvent` type union in `lib/store.ts`.
- README: document `FACTORY_MIN_FREE_GB`, the default, and that a refusal exits 1 (so under the watcher it
  pauses the repo until a restart).

## Constraints

- Node 24, no new dependencies (`fs.statfsSync`), TypeScript run directly.
- Tests in `test/` with `node --test`, written first, with `freeSpace` injected so they never touch the real
  disk. Style of `test/build.test.ts`.
- Commits as the repo's bot identity, no `Co-Authored-By` lines. One PR into `main`.

## Calls made by the writer

- Env var name `FACTORY_MIN_FREE_GB`; gigabytes are binary (1024³), matching `statfs` block math.
- Guard throws (exits 1 via the existing top-level catch) rather than returning a `refused` report, so the
  message is plain and the agent steps are covered, not just the claim.
- One guard per gate round and per review round (not per sub-pass); "round" is the unit the spec names.
