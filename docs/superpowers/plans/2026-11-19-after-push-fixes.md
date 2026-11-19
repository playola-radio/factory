# After-push fixes

Spec: `docs/superpowers/specs/2026-11-18-installable-factory-design.md`, "After-push command". These fix four
problems in the merged after-push code in `lib/review.ts`, `lib/workshop.ts` and `lib/store.ts`. With no
after-push command set, nothing changes.

## Stage 1: Catch the worktree up with the PR branch on GitHub
**Goal**: with an after-push command set, when the worktree's head differs from GitHub's, `watchPr` first calls
`Workshop.catchUp(worktree, branch, githubHead)`, which fetches the PR branch and then fast-forwards the worktree
(GitHub ahead), pushes the local commits (worktree ahead), or merges GitHub's head into the worktree and pushes
(diverged). It never force-pushes. A merge that conflicts is aborted, and the PR ends `fix failed` with a reason
that says how to resolve it. After a fast-forward the pass goes on as synced; after a push it waits and reads
GitHub again, so it never merges or acts on a state read before its own push. The `synced` flag and the trailing
`if (!synced) continue` go away: every pass that gets past the catch-up is synced.
**Success Criteria**: an owner push to the PR branch no longer stalls the PR: the worktree catches up, the
after-push command runs per the fingerprint rule, held replies post, and an approved PR merges. Unpushed local
commits get pushed. A diverged branch gets merged and pushed, or ends `fix failed` on a conflict.
**Tests**: `test/build.test.ts`: owner push (GitHub ahead) → caught up, command not rerun without `whenChanged`,
merged; owner push with held replies → replies post after the catch-up; unpushed local commits → pushed, then
merged; diverged → merged and pushed, then merged; diverged with a conflict → `fix failed` with the reason, nothing
posted or merged. `realWorkshop.catchUp` against real git repos (a bare remote and two clones): fast-forward, push,
merge + push, conflict aborted and reported.
**Status**: Complete

## Stage 2: Held replies survive the end of a build
**Goal**: `PrReport.held?: { replies: { item: ReviewItem; body: string; resolve: boolean }[]; reReview: boolean }`,
saved whenever `held` changes; `watchPr` starts from `report.held` and posts it once synced and the after-push
command has succeeded, then clears it.
**Success Criteria**: replies held when the after-push command fails post exactly once on the next build, together
with the held re-review request, and the item they answer is not answered again from the same GitHub read. A
report saved without `held` loads.
**Tests**: `test/build.test.ts`: after-push fails after a review fix → the report stores the held reply; the next
build runs the command, posts the reply and the re-review once, no second agent round for that item, and the stored
`held` is gone. Existing tests already load reports with no `held`.
**Status**: Complete

## Stage 3: A timed-out after-push command stops all its processes
**Goal**: `runAfterPush(cwd, command, env, timeoutMs)` in `lib/workshop.ts` runs `sh -c` with async `spawn`,
`detached: true`, in its own process group; on timeout it sends SIGTERM to the group, then SIGKILL after a short
grace. `Workshop.afterPush` becomes async and calls it with the 30-minute limit. Keeps the cwd, the bot
`GH_TOKEN`, the 64 MiB output cap and the error text (timeout, exit code, last 20 lines of output).
**Success Criteria**: after a timeout no process the command started is left running.
**Tests**: `runAfterPush` with a 300 ms limit on `sleep 300 & echo $! > child.pid; wait` rejects with "ran past …
and was stopped" and the child pid is gone; the existing bot-token and last-output test, made async.
**Status**: Complete

## Stage 4: Excess-audit cleanups
**Goal**: delete the trailing `if (!synced) continue` in `watchPr` (gone with Stage 1) and the test `with no
after-push command nothing is run`, which is a duplicate: `test/repo.test.ts` covers "no factory files means no
after-push", and `a bot's finding is fixed, pushed, answered…` already asserts `afterPushes: []` with no rules.
**Success Criteria**: `node --test` passes.
**Tests**: none new.
**Status**: Not Started
