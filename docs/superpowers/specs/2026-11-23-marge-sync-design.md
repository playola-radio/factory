# Reporting to marge: the factory's sender

Date: 2026-11-23. Status: built.

## Intent

marge-web's `/factory` page shows what the factory is building. Its design (marge-web
`factory/done/002-factory-overview/`) built the receiver, `POST /v1/factory/sync`, and left the sender to this repo.
Until a sender exists the page reads "Not connected yet". The contract in that folder's `ApiContract.md` is
canonical; this spec only says how the factory meets it.

## Where it runs

Inside `factory watch`, beside the build scheduler, in the same process. The watcher is the only process that knows
which repos it paused, and a heartbeat from a separate job could keep the page green after the watcher died.
`watch()` shares its paused map (repo path → exit code) with the sender; nothing else in the scheduler changes.

The sender polls every 5 seconds for a cheap change signal: the size of `events.jsonl` and the paused map. On a
change, or 60 seconds after the last push, it reads the whole state (claims, PR reports, the event log, the base
views' `factory/` folders) and sends one push built from that read. A push that fails waits 60 seconds before the
next try. A state read that throws sends nothing, so the page goes stale rather than looking healthy.

If `FACTORY_REPORT_TOKEN` is unset, or `MARGE_API_URL` is set to an empty string, the sender logs once and stays
off; builds are unaffected. `MARGE_API_URL` defaults to `https://api.marge.playola.fm`. `run-watch.sh` sources
`$FACTORY_HOME/env` and then `$FACTORY_HOME/secrets.env` when present.

## Ids

- **Run id.** `startOrResume` gives each new claim a `runId` (`randomUUID`) stored in `claim.json`; a design given
  up and claimed again gets a new one. Every event a build writes carries its claim's `runId`. A disk refusal
  before any claim gets a run id of its own.
- **Event id.** `store.record` gives every new event an `id` (`randomUUID`) as it appends the line.
- **History written before ids existed** is sent once, like new events. A line without an `id` gets one derived
  from its byte offset and text. A line without a `runId` belongs to the latest `design claimed` line for the same
  repo and design before it, and its run id is derived from that repo, design and claim time. A claim on disk
  without a `runId` derives the same value from its own `startedAt`, so a build in flight at upgrade keeps one
  history.

## Reports (artifacts)

When a build records an event that ends a step, it passes the PR report as saved at that moment: `pr implemented`,
`pr needs attention`, every gate outcome, `pr opened`, `review round`, `pr merged` and `pr closed`. The store writes
a copy to `$FACTORY_HOME/artifacts/<event id>.json` and sets the event's `artifactId` to the event's own id. The copy
leaves out the worktree path. A report over 256 KiB is replaced by a short stub saying so, because the server would
refuse the whole push otherwise. Copies live outside `builds/`, so finishing a design does not delete them; the
sender deletes each one after a push carrying it gets `204`.

## The push

- **History.** A byte cursor in `$FACTORY_HOME/sync.json` marks the end of the last line marge accepted. Each push
  carries the complete lines after it, oldest first: at most 500 events, 50 reports, and about 4 MB in all. A line
  that cannot be read, or breaks the contract's rules, is logged and skipped. The cursor moves only on `204`. When
  more history is waiting, the next push goes on the next 5-second poll.
- **Status list.** Fixed in `lib/snapshot.ts`, in the page's sort order: `needs_you` (attention), `stopped`
  (failure), `no_progress` (quiet), `running` (active), `done` (complete).
- **Builds.** One row per watched repo with a claim, plus one per `design finished` event in the last 24 hours.
  - Stages: Implement, Review gate, PR open, Reviewers, Merge. The current stage comes from the current PR's latest
    event (the first planned PR whose report is not merged).
  - Status, first match wins: the watcher paused the repo → `stopped`; the current PR's latest event is
    `pr waiting on owner` → `needs_you`; nothing new for 60 minutes → `no_progress`; otherwise `running`.
  - `review.ts` now records `review started` when the bot begins a review round, so a PR the bot is working on
    again stops reading "needs you" at once.
  - A paused repo with no claim gets no row: the watcher saw only an exit code and cannot say which design it was.
  - Finished rows show PR `n of n`, where `n` is the highest PR number in that run's events; finishing requires
    every PR merged, so that is the plan's length.
- **Counts.** From each repo's base view (`$FACTORY_HOME/worktrees/<repo>/base`), which every build refreshes:
  designs in `factory/ready` that are buildable and not claimed, those that are not buildable, and folders in
  `factory/done`.

## Not here

- Sending a `details` object on events (optional in the contract; nothing reads it until design 003).
- A row for a paused repo with no claim, and for a disk refusal before claiming. Both are logged in `watch.log`.
- Retrying faster than once a minute after a failure, or exponential back-off: the page only goes stale after
  3 minutes, so a steady 60-second retry is enough.
