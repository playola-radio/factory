# `factory notify`: one notification per thing a person must know

Date: 2026-11-20. Status: proposed.

## Intent

The factory runs unattended on the Mac mini. Every build appends JSON lines to `$FACTORY_HOME/events.jsonl`
(`lib/store.ts`), but nothing reads them, so nobody is told when something needs a person. On 2026-11-20 a build
crashed when the disk filled, `factory watch` paused all three repos, and nobody knew for 45 minutes — until the
owner noticed a PR had gone quiet.

`factory notify` is the "later events.jsonl consumer" the watch spec
(`docs/superpowers/specs/2026-11-19-factory-watch-design.md`) deferred. It follows `events.jsonl` and writes one
notification per thing a person actually needs to act on, as a single JSON line appended to
`$FACTORY_HOME/notifications.jsonl` and printed to stdout. It talks to no outside service. Tying those lines into
Slack or anywhere else is later, separate work; this command only produces the lines.

## What this is: a thin follower

`factory notify` tails one append-only file and writes another. It holds no model of the build, reaches no
network, and makes one decision per line: is this a thing a person must know? If so, it emits a notification; if
not, it moves on. All the meaning already lives in the events the factory writes.

The one place the events fall short is a build that *dies* — disk full, OOM, `SIGKILL`. The dying process writes
no event, so `events.jsonl` has nothing for the notifier to find. The fix lives in `factory watch`, not here (see
"The gap: a build that stops without an event").

## Goals

- A long-running command, `factory notify`, that follows `$FACTORY_HOME/events.jsonl` and appends one
  notification per person-relevant thing to `$FACTORY_HOME/notifications.jsonl`, also printing it to stdout.
- Survive restarts without repeating or missing a notification, across an ungraceful kill.
- Close the gap where a crashed or watcher-paused build currently notifies nobody.
- Run on the Mac mini the way the watcher does: start on login, stay up, pick up new factory code.

## Non-goals

- Sending anything anywhere. No Slack, no email, no webhook, no HTTP. The output is a local JSONL file and
  stdout. A downstream consumer of `notifications.jsonl` is later, separate work.
- A notification per event. Most events are routine (`design claimed`, `pr started`, `gate started`, every
  `review round`, each `pr merged`); they are not emitted as notifications.
- Reading factory state, GitHub, or a build's output. The notifier reads exactly one file: `events.jsonl`.
- Reconstructing history on first install. A fresh notifier starts at the end of `events.jsonl` and notifies only
  on what happens from then on (see "Restart safety").
- Configuration. There is nothing to configure; the notifier reads `$FACTORY_HOME` and follows the one file.

## Anti-goals

- A notification the owner learns to ignore. Noise defeats the purpose: if routine progress is notified, the one
  line that matters is lost in the stream. Only person-actionable things are emitted.
- A missed stop. The 2026-11-20 incident must produce a notification. A build that stops for any reason — crash,
  a PR that will not merge, a plan that cannot start — must surface.
- A repeated notification. Restarting the notifier (by hand, or by the updater on a new `main`) must not re-emit
  lines it already wrote.

## What the factory records today (what the notifier reads)

Every event is a JSON object on one line in `events.jsonl`, written by `lib/store.ts`'s `record`:

```
{ "at": "<ISO>", "repo": "<owner/name>", "design": "<nnn-name>", "pr": <number?>, "type": "<type>" }
```

The types seen so far: `design claimed`, `design abandoned`, `design finished`, `pr started`, `pr implemented`,
`pr needs attention`, `gate started`, `gate clean`/`gate stopped at round limit`/`gate did not run`/`gate fix
failed`, `pr opened`, `review round`, `pr waiting on owner`, `pr merged`, `pr closed`, `pr fix failed`.

Two of these are the signals a person must act on:

- **`pr waiting on owner`** — the bot has done everything it can on an open PR and the ball is in the owner's
  court. It fires **once** each time the wait begins (`lib/review.ts` guards it with `toldOwner`, resetting only
  when the bot does more work), so it is already not per-round.
- **`design finished`** — every PR of a design merged; the design shipped.

## Design

### The command

```
factory notify
```

It reads `$FACTORY_HOME` (the same `HOME` the rest of `bin/factory.ts` uses), follows `events.jsonl`, and loops
until `SIGTERM`/`SIGINT`, the way `factory watch` does. No flags, no config file.

It follows the file by **polling**, as the watcher polls builds — no `fs.watch`, no dependency. Each tick it
reads the bytes appended since its cursor, processes every complete line, and sleeps a short interval (suggested
default 2 seconds; the real interval is injected so tests run without a clock — see Constraints).

### Which events become notifications

| Event | Notify? | kind | Why |
|---|---|---|---|
| `pr waiting on owner` | yes | `pr-waiting-on-owner` | A PR is open and needs the owner. |
| `design finished` | yes | `design-finished` | A design's PRs all merged; it shipped. |
| `repo paused` (new; see below) | yes | `repo-stopped` | A build stopped and the watcher paused the repo; a person must look. |
| everything else | no | — | Routine progress, or subsumed by `repo-stopped`. |

`pr opened` is **not** notified: when a PR opens the bot immediately starts on checks and review rounds; the
owner is not needed until `pr waiting on owner`. Every `review round` is silent, as the brief requires.

`pr waiting on owner` is de-duplicated so it fires **once per distinct wait** (see "Firing once per wait").
`design-finished` and `repo-stopped` are not de-duplicated: a design is finished once (its claim is then
released, so the event never re-fires), and a repo that fails again after a retry is a true, fresh signal
("tried again, still broken") worth repeating.

`pr needs attention`, `pr closed`, and `pr fix failed` are **not** notified directly. Under the watcher, every
build that ends on one of these exits non-zero, which pauses the repo and emits `repo paused` — so the stop is
caught there, once, by the single signal that also catches a crash (see below). Notifying on both would
double-fire for the common case; `repo-stopped` is the one umbrella signal.

### The notification format

One JSON object per line in `notifications.jsonl`, also printed to stdout (so launchd's `notify.log` carries a
human-tailable copy):

```json
{
  "at": "2026-11-20T18:04:11.000Z",
  "kind": "repo-stopped",
  "repo": "/Users/brian/playola/playola",
  "design": "007-widget",
  "pr": 42,
  "summary": "playola stopped (exit 2); the watcher paused it until it is restarted.",
  "event": "repo paused",
  "source": 20481
}
```

- `at` — the source event's own timestamp (when the thing happened), so re-processing the same line after a
  restart yields an identical notification.
- `kind` — one of `pr-waiting-on-owner`, `design-finished`, `repo-stopped`. The stable machine category a
  downstream (Slack, etc.) routes on.
- `repo` — the repo as the source event names it: the GitHub `owner/name` for PR and design events, the
  filesystem path for `repo-stopped` (see the call below on why they differ).
- `design`, `pr` — copied through when the source event carries them. `repo-stopped` carries neither.
- `summary` — one human line a downstream can post as-is.
- `event` — the source event `type`, for a downstream that wants the raw cause.
- `source` — the byte offset in `events.jsonl` just past the triggering line. The exactly-once key (below). A
  downstream ignores it.

### The gap: a build that stops without an event

A build that dies — disk full, OOM-killed, `SIGKILL` — writes no event: the dying process cannot. `lib/build.ts`
cannot cover this, because it is the thing that died. A repo that the watcher pauses after a non-zero exit also
writes no event today (`lib/watch.ts` only logs `exited N; leaving it until the watcher restarts` to
`watch.log`). So the notifier, reading only `events.jsonl`, would see nothing — exactly the 2026-11-20 blind
spot.

The one process still alive when a build dies is `factory watch`, and it already makes the decision that matters:
on any non-zero exit it pauses the repo. **The smallest honest fix is to have the watcher record a `repo paused`
event at that moment.** That single event fires for every stop — a crash, a plan that cannot start (exit 1), a PR
that will not merge (exit 2), a `needs attention` that gave up — so the notifier needs no special knowledge of
why a build died. It is the signal that would have caught the incident.

This **revises** the watch spec's non-goal "Notifications of any kind. … this command writes nothing there": the
watcher now writes exactly one kind of event, `repo paused`, into `events.jsonl`. It still sends nothing anywhere
and still reads nothing but a build's exit code. The code PR updates that non-goal with a dated note pointing
here.

The new event, written through the existing `lib/store.ts` `record` so its shape and location match every other
event:

```
{ "at": "<ISO>", "repo": "<filesystem path>", "type": "repo paused", "exitCode": <number> }
```

This requires two small changes to the shared types in `lib/store.ts`: `design` becomes optional on
`FactoryEvent` (the watcher does not know which design a build was on — it reads only the exit code), and a
`'repo paused'` member and optional `exitCode` field are added. The watcher records it through an **injected
effect** (like `startBuild`, `sleep`, `log`), so the scheduler loop stays testable without touching disk; the
real effect appends via `diskStore($FACTORY_HOME).record(...)`.

The write is **best-effort**: it is wrapped so a failed append (most relevantly `ENOSPC` — the disk is full,
which is the very thing that stopped the build) is logged to `watch.log` and swallowed, never crashing the
watcher or leaving an unhandled rejection. A crash-looping watcher is worse than a missed line. The notifier
appends to `notifications.jsonl` the same way. See the disk-full limitation in the calls below.

### Firing once per wait

`pr waiting on owner` fires once per wait *only within one build process* — `lib/review.ts` guards it with an
in-memory `toldOwner`. But the updater restarts the watcher on every `main` move, which resumes `factory build`
and re-enters the PR loop from the top; a PR still only waiting on the owner re-records `pr waiting on owner` as a
brand-new line at a new offset. The exactly-once guard below does **not** catch this — it only catches re-reading
the *same* line after a crash. So a PR left waiting would be re-notified on every factory redeploy, which hits
the "a notification the owner learns to ignore" anti-goal.

The notifier therefore keeps a small **waiting set** of the PRs it has already sent a `pr-waiting-on-owner` for,
persisted as durable state (below). The rule, applied as each event is processed:

- `pr waiting on owner` for a PR not in the set → emit, and add the PR to the set.
- `pr waiting on owner` for a PR already in the set → skip (same wait, already told).
- any event that means the bot is working the PR again — `pr started`, `pr opened`, `review round` — → remove the
  PR from the set, so the *next* genuine hand-off to the owner fires again.
- `pr merged`, `pr closed`, `pr needs attention` → remove the PR from the set (the PR is done or has stopped).

A PR is keyed by `repo` + `pr` (both are on every PR event). This models "once per distinct wait" correctly
across restarts without the notifier rebuilding the build's whole state machine.

### Restart safety (no repeats, no misses)

Three files under `$FACTORY_HOME`:

- `events.jsonl` — input, append-only.
- `notifications.jsonl` — output, append-only, and the source of truth for what was actually emitted.
- `notify.state` — a small JSON file, written atomically each tick (temp file + `rename`), holding the resume
  offset and the waiting set: `{ "offset": <byte offset into events.jsonl>, "waiting": ["owner/name#42", …] }`.

`emittedThrough` — the exactly-once high-water mark — is **not** stored here. It is derived at startup from the
`source` offset on the last complete line of `notifications.jsonl` (`0` if none), because it must reflect what
was *durably written*, independent of `notify.state`. The waiting set and the offset, by contrast, are pure
functions of the event stream, so a stale copy is always corrected by reprocessing (below).

The loop:

1. **On start.** Read `emittedThrough` from the last complete line of `notifications.jsonl`. If `notify.state`
   exists, take `offset` and `waiting` from it. If not (first run), set `offset` to the current byte length of
   `events.jsonl` — start at the end, so a fresh install does not replay history — `waiting` empty, and write
   `notify.state` at once, before processing, so a crash during the first tick cannot re-do "start at the end"
   and skip what arrived in between. If `events.jsonl` does not exist yet, `offset` `0` and wait for it.
2. **Each tick.** `stat` `events.jsonl`. If its size is below the offset (a truncation or replacement that should
   never happen for an append-only file), log it and reset **both** the offset to the new end **and**
   `emittedThrough` to `0` — the old high-water mark is meaningless against a new file, and leaving it high would
   make every later line fail the `E > emittedThrough` guard and silently suppress every future notification
   (a stated anti-goal). Then read from the offset to end. Split on `\n`; a trailing segment with no newline is a
   half-written line — leave it unconsumed, keeping the offset at its start.
3. **Per complete line** (ending at byte `E`): parse it (a malformed line is logged and skipped, never fatal);
   apply its effect on the **waiting set** (add/remove per "Firing once per wait") — this always happens, even
   for a line the guard will suppress, so the set stays correct on reprocess. Then decide whether it is a
   notification. Append it to `notifications.jsonl` (flush), set `emittedThrough = E`, and print it to stdout
   **only if** it would notify **and** it survives the waiting-set rule **and** `E > emittedThrough`. Advance the
   offset to `E` regardless.
4. **After the batch.** Write `notify.state` (`offset` + `waiting`) atomically.
5. Sleep the poll interval; repeat until signalled.

Why this is exactly-once across a `kill -9`:

- Killed after a notification is flushed but before `notify.state` is written: on restart `offset` still points
  before that line, so it is re-read — but its end offset `E` is `≤ emittedThrough` (the last notification's
  `source`, read from `notifications.jsonl`), so the guard suppresses the duplicate. The waiting-set effect is
  re-applied during the reprocess, so the set ends correct too. Later lines are new. **No repeat, no miss.**
- Killed after advancing the offset across many non-notifying lines: `notify.state` persists the position, so a
  restart resumes past them. **No miss, no flood.**

The notification is written *before* `notify.state` advances (never after), so a crash can at worst leave the
offset behind the notification — recoverable by the `emittedThrough` guard — never ahead of an unwritten
notification, which would lose a line. The waiting set rides in the same `notify.state`, so it can never be more
advanced than the offset, and reprocessing always rebuilds it correctly.

### Running it on the Mac

A third launchd agent, beside `com.playola.factory-watch` and `com.playola.factory-updater`:

- **`com.playola.factory-notify`** runs `factory notify` via a new `deploy/run-notify.sh`, `RunAtLoad` +
  `KeepAlive`, stdout and stderr to `$FACTORY_HOME/notify.log`. `run-notify.sh` mirrors `run-watch.sh`: it
  sources `$FACTORY_HOME/env` (launchd gives a bare `PATH`, and the notifier needs Node from nvm) and execs
  `factory notify` from this same checkout.

`deploy/install-launchd.sh` and `deploy/uninstall-launchd.sh` gain the third label (their `LABELS` array), and a
`com.playola.factory-notify.plist.template` joins the two existing templates. The updater
(`deploy/auto-update.sh`) sends `TERM` to the notify label alongside the watch label when `main` moves, so the
notifier runs the new code; `KeepAlive` brings it back. Restarting the notifier is always safe — it resumes from
`notify.state` and never repeats or misses — so, unlike the watcher, it needs no "wait for agents to go quiet"
dance.

## Constraints

- Node 24, no dependencies, TypeScript run directly, as the rest of the repo.
- Tests in `test/` with `node --test`, in the style of `test/watch.test.ts`: the notifier's logic takes its
  effects (read the new bytes, read/write `notify.state`, append a notification, read the clock, sleep) as
  arguments, so the follower and the event→notification decision test without processes, files, or a real clock.
  Cover: first-run-starts-at-end, a kill between notification and state write does not repeat, a kill mid-batch
  does not miss, a half-written trailing line is not consumed, a malformed line is skipped not fatal, a truncated
  file resets cleanly, and the waiting-set rule (a second `pr waiting on owner` with no bot work between is
  suppressed; one with a `review round` between fires again; it survives a restart).
- The watcher's `repo paused` write goes through `lib/store.ts`, and the notifier reuses the same JSONL
  conventions — no hand-rolled JSON shapes.
- Commit messages and PR conventions as in this repo's history (`feature:`, `bugfix:`, `chore:`), committed as
  the repo's bot identity, no `Co-Authored-By` lines.

## Order of work (the code PR)

1. The `repo paused` event: make `design` optional on `FactoryEvent` and add the `'repo paused'` type and
   `exitCode` in `lib/store.ts`; have `lib/watch.ts` record it on pause through an injected effect; tests for the
   loop and for the real effect's shape.
2. The pure follower in a new `lib/notify.ts`: offset tracking, line splitting (including the half-written
   trailing line), the event→notification map, the waiting-set rule, and the exactly-once guard — all over
   injected effects; tests.
3. Wire `factory notify` into `bin/factory.ts`: real effects over `events.jsonl`, `notifications.jsonl`, and
   `notify.state`, with `SIGTERM`/`SIGINT` handling mirroring `watch`.
4. `deploy/`: `run-notify.sh`, the plist template, the third label in install/uninstall, and the updater restart;
   extend `test/deploy.test.ts`.
5. Docs: a `factory notify` line in `bin/factory.ts`'s usage and the top-level README; the deploy README's third
   job; and a dated note on the watch spec's notifications non-goal pointing here.

## Left to the builder

- Module and function names, and the exact signatures of the injected effects.
- The poll interval default (2 seconds suggested) and whether to expose it as a flag (not required).
- Plist details beyond `RunAtLoad`/`KeepAlive`/log path, matching the two existing templates.
- Exactly how `emittedThrough` is read from `notifications.jsonl` on start (read the last complete line).

## Calls made by the writer, for the owner to check

- **Category "a build stopped" is the watcher's new `repo paused` event only** (the owner chose this over also
  notifying on `pr needs attention`/`pr closed`). It is coarse — "repo X stopped, exit N, see watch.log" — but it
  is the one signal that catches a crash, and every watcher-run stop pauses the repo, so nothing is missed and
  nothing double-fires.
- **A build run by hand, outside the watcher, produces no stop notification** — nothing pauses it, so no `repo
  paused` is written. Such a build is attended by the person who ran it, so this is acceptable.
- **`repo paused` carries the repo's filesystem path and exit code, not the GitHub `owner/name`.** The watcher
  knows the path it was configured with and must not start reading git remotes just to prettify a line; PR and
  design events keep carrying the GitHub id. So a notification's `repo` means "whatever identifies the repo in
  that event," and a downstream should treat it as an opaque label.
- **`pr waiting on owner` and `design finished` are the only non-stop notifications.** `pr opened`, every `review
  round`, and each `pr merged` stay silent.
- **`pr waiting on owner` is de-duplicated to once per distinct wait** (the owner's choice), via a persisted
  waiting set cleared by bot-progress events — so a PR left waiting is not re-pinged on every factory redeploy,
  but a genuine second hand-off to the owner still fires. `design-finished` and `repo-stopped` are not
  de-duplicated (a design finishes once; a repeated failure after a retry is a real repeated signal).
- **First run starts at the end of `events.jsonl`**, so installing the notifier does not replay the whole
  history; it notifies only on what happens afterward. Every later restart resumes from `notify.state` and misses
  nothing.
- **The notifier is its own launchd job and the updater restarts it on a new `main`.** It is always safe to
  restart because it resumes from `notify.state`.
- **This supersedes the watch spec's "writes no notifications" non-goal:** the watcher now writes exactly one
  event type, `repo paused`, and still sends nothing to any service.
- **Known limitation — a truly full disk.** Both the `repo paused` event and the notification are local files on
  the same disk that may be full. On `ENOSPC` the writes are best-effort: the watcher stays up, but the line may
  be delayed until space frees, or lost if the event write itself fails. Escaping a full local disk needs an
  off-machine channel, which the owner scoped to the later Slack tie-in; it is out of scope here. In practice a
  crashed build usually frees space (worktrees, temp files) and a few-hundred-byte append then succeeds where the
  build's large writes did not, so the common case is a delayed line, not a lost one.
