# Review-reply follow-ups

Spec: `docs/superpowers/specs/2026-11-18-installable-factory-design.md`, "After-push command". Follows
`2026-11-19-after-push-fixes.md` (factory #5), whose report left these two gaps. A build that never hits them
behaves as before.

## Stage 1: A review reply is posted at most once
**Goal**: `Workshop.reply(number, item, body)` only posts; a new `Workshop.resolve(thread)` resolves. A held reply
that needs resolving is saved as `posted: true` between the two calls, so a resumed build (after a failed resolve
or a stop between the calls) only resolves it. Chosen over asking GitHub for the bot's earlier reply because it
needs no extra GitHub read and the queue is already saved after each step. A failed resolve is kept: the pass
waits and the next pass (or build) tries again; after 3 failed tries in one build the PR ends `fix failed` with a
reason that names the thread and says to resolve it on GitHub or build again. A pending resolve blocks the merge
and the next agent round, as any held reply does.
**Success Criteria**: no reply is posted twice; a thread whose resolve keeps failing ends the build with a clear
reason; old reports (no `posted`) load.
**Tests**: `test/build.test.ts`: resolve fails once → the next pass resolves, one reply; resolve fails 3 times →
`fix failed` naming the thread, the stored held reply is `posted: true`, the next build resolves without posting;
the report saved when the resolve began (a build stopped between the calls) → the next build resolves without
posting.
**Status**: Complete

## Stage 2: Every push catches up with GitHub first
**Goal**: no push in `implement.ts`/`review.ts` is a plain `workshop.push`; each goes through
`Workshop.catchUp` (fast-forward / push / merge and push / conflict → `fix failed` with instructions, never a
force-push). A new `PrReport.mustCatchUp?: true` makes the top-of-pass catch-up run even with no after-push
command; it is set when the resumed last PR commits the design move, and before a review fix is pushed, and is
cleared when a pass sees the worktree at GitHub's head. A review fix whose push meets a moved branch keeps its
held replies until the catch-up has pushed it.
Push calls checked: `implement.ts` design-move on resume (fixed), `review.ts` clean base merge (fixed),
`review.ts` review fix (fixed), `catchUp`'s own push (it is the catch-up), `openPullRequest`'s first push (judged
safe: it pushes a branch nobody else has seen yet; a rejected push stops the build loudly, nothing is forced).
**Success Criteria**: a resumed build whose PR branch moved on GitHub catches up instead of pushing; diverged →
merged and pushed; conflict → `fix failed` with instructions, and the flag survives to the next build.
**Tests**: `test/build.test.ts`: resumed last PR, GitHub ahead and diverged → catch-up merges and pushes, no plain
push, PR merges at the merged head; conflict → `fix failed` with the instructions, the next build (conflict
resolved) catches up and merges; a review fix whose push finds GitHub moved merges it in, then posts. Existing
tests unchanged except the fake workshop's `reply`/`resolve` split and its catch-up only modelling GitHub
movement when GitHub's head is not the one last pushed.
**Status**: Not Started
