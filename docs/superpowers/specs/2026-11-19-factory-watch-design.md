# `factory watch`: build new designs unattended

Date: 2026-11-19. Status: awaiting the owner's approval.

## Intent

The build Mac should notice when a finished design lands in any of several repos and build it, with nobody
starting anything by hand. Today `factory build <repo>` builds every ready design in one repo and then exits; it
does not watch, and it knows about one repo at a time.

The first use is the bot's Mac mini, watching `playola`, `playola-radio-ios` and `playola-radio-android` (all
cloned under `~/playola/`, all building into `develop`).

## Goals

- One long-running command, `factory watch`, that keeps a `factory build` going for every repo in a list.
- A generic notification whenever something happens that a person would want to know about. It names no
  service. Slack, or anything else, is tied in later by reading what the watcher writes.
- A way to run it on the Mac so it starts on login, stays up, and picks up new factory code from `main`.

## Non-goals

- Sending notifications anywhere (Slack, email, iMessage).
- Changing the build itself: the review loop, the gate, the prompts. `factory watch` only starts
  `factory build` and reads how it ended.
- Watching GitHub by webhook. Polling is enough.
- Pulling Playola-specific values (owner, bot account, base branch) out of the code. That is separate work.

## Anti-goals

- A stuck build retried forever. Re-running a build whose review fix failed runs the agents again each time.
- The same notification repeated on every poll.
- An update that kills an agent mid-implementation.

## How a build behaves today (what the watcher relies on)

- `factory build <repo> --base <branch>` fetches the base branch from GitHub into a checkout the factory owns,
  so a poll only needs the clone to exist. It reads designs from `factory/ready/`.
- It stays alive for as long as a design is in progress, including the days a PR may wait for the owner's
  approval. While waiting it only polls GitHub.
- It refuses to start if another build is running on the same repo (`build.pid` under `~/.factory/worktrees/`).
- It can be killed and started again: it continues the design in progress.
- How it ends:

| Exit | Meaning | Printed on stdout |
|---|---|---|
| 0 | Nothing to build, or every design is built | `{ "state": "nothing to build" }`, or the last design's report |
| 1 | Cannot start: the next design is `not buildable` or `refused`, or an error was thrown | the report, or the error on stderr |
| 2 | A PR did not merge: `needs attention`, `stopped`, review `closed` or `fix failed`, or the gate was not clean | the PR's report |

- After `needs attention`, running the build again is the factory's own retry, capped at three attempts. After
  that it reports `stopped` without running an agent.

## Approaches considered

1. **A `factory watch` command in this repo, kept alive by launchd. Chosen.** The logic is testable, it lives
   beside the code it drives, and it has a place for the hold rule and the notifications.
2. **A launchd timer that runs `factory build` for each repo every few minutes.** Almost nothing to write, but
   nowhere to put notifications, and a stuck build is retried forever.
3. **Have marge-bot run it.** It already runs on the Mac, but it ties the factory to the bot's code and
   releases, which works against the factory being installable on its own.

The owner picked 1, and asked that notifications be generic rather than written for Slack.

## Design

### The command

```
factory watch [--config <path>]
```

It reads the config, then loops until it is told to stop (SIGTERM or SIGINT). Each pass, for every repo:

1. If a build the watcher started is still running, leave it alone.
2. If the repo is on hold (below), check whether the hold is released. If not, skip it.
3. Otherwise start `factory build <path> --base <base>` as a child process and remember it.

When a child exits, the watcher reads its exit code and the JSON on its stdout, sends any notification that
applies, and decides whether the repo goes on hold. It then sleeps `pollSeconds` and starts the next pass.

Builds for different repos run at the same time, each as its own child. On SIGTERM the watcher passes the
signal to its children, waits for them to exit, and exits. That is safe because a build continues where it left
off.

The watcher starts `factory build` through the same `bin/factory.ts` it was started from, so both always run
the same version.

### Config

`~/.factory/watch.json` (under `$FACTORY_HOME` when that is set):

```json
{
  "pollSeconds": 300,
  "repos": [
    { "path": "~/playola/playola", "base": "develop" },
    { "path": "~/playola/playola-radio-ios", "base": "develop" },
    { "path": "~/playola/playola-radio-android", "base": "develop" }
  ]
}
```

`path` may start with `~/`. `base` is required: the watcher never guesses a branch. `pollSeconds` defaults to
300. Unknown fields, a missing file, a path that is not a git clone, or two entries for the same repo are
errors that stop the watcher at startup with a message saying what to fix.

### When a repo goes on hold

A build that ended badly must not be started again on every pass.

| How the build ended | What the watcher does |
|---|---|
| Exit 0 | Start it again on the next pass (this is the poll for new designs). |
| Exit 2, report state `needs attention` | Start it again on the next pass. The factory caps this at three attempts. |
| Any other exit 2, or exit 1 | Put the repo on hold. |
| Killed by the watcher shutting down | Nothing; the next watcher start continues it. |

A hold records the commit the base branch was at on GitHub and the repo's claim file contents (or that there
was none). Each pass, the watcher releases the hold when either has changed: `git ls-remote origin <base>`
shows a new commit, or the claim differs (someone ran `factory abandon`, or fixed things and the claim moved
on). Restarting the watcher also clears every hold; that is the manual "try again".

Holds live in memory only. That is deliberate: a restart is how a person asks for a retry.

### Notifications

Every notification is one JSON object on one line, appended to `~/.factory/notifications.jsonl` and also
printed to the watcher's stdout. Nothing else reads or sends them; a later integration tails the file.

```json
{"at":"2026-11-19T22:10:00.000Z","kind":"build stopped","repo":"playola-radio/playola","design":"003-station-setup","summary":"PR 2 still needs attention after 3 attempts: Check failed: make test-server. Its work is in …","detail":{ }}
```

- `at`: ISO time. `kind`: one of the values below. `repo`: `owner/name`, as the factory already names repos.
- `design`: present when the notification is about one design.
- `summary`: one plain sentence a person can act on, built from the build's own report.
- `detail`: the build's report or error, unchanged, for anything that wants more.

| `kind` | When |
|---|---|
| `build started` | A build claimed a design, or picked one back up after a restart. |
| `design finished` | A build reported that every PR of a design merged. |
| `build stopped` | A build ended in a way that put the repo on hold. The summary says why. |
| `hold released` | A held repo is being tried again, and why (base moved, claim changed). |
| `watcher error` | The watcher itself could not do something, such as reach GitHub for a held repo. |

A PR waiting for the owner's review is not a notification: GitHub already tells the owner, and the factory
records it in `events.jsonl`.

The same notification is never written twice in a row for a repo: if `kind`, `design` and `summary` match the
last one written for that repo, it is skipped. `watcher error` for the same cause is written once until the
cause clears.

### Running it on the Mac

Two launchd agents, in the style of `~/Projects/marge-bot`:

- `com.playola.factory-watch`: runs `factory watch`, `RunAtLoad` and `KeepAlive`, stdout and stderr to
  `~/.factory/watch.log`.
- `com.playola.factory-updater`: runs `deploy/auto-update.sh` every two minutes. It fetches `origin/main`; if
  there is something new it fast-forwards the checkout and restarts the watcher (`launchctl kill TERM`, then
  KeepAlive brings it back on the new code).

The updater must not restart the watcher while an agent is working, since that throws away the agent's
run. It waits while any trace file under `~/.factory/runs/` has been written to in the last two minutes
(agents stream their output there), up to 45 minutes, then restarts anyway and says so in its log. A build
that is only waiting on the owner writes no trace, so it never delays an update.

The agents need a fuller environment than launchd gives them (Node from nvm, Homebrew's Ruby, Java,
`ANDROID_HOME`, Maestro). The watcher is started through `deploy/run-watch.sh`, which sources
`~/.factory/env` if it exists and then runs `factory watch`. `~/.factory/env` is written by hand on each
machine and is not in the repo.

`deploy/install-launchd.sh` writes both plists into `~/Library/LaunchAgents` with this machine's paths and
loads them; `deploy/uninstall-launchd.sh` unloads and removes them. Both are safe to run again.

## Constraints

- Node 24, no dependencies, TypeScript run directly, as the rest of the repo.
- Tests in `test/` with `node --test`, in the style of `test/build.test.ts`: the watcher's logic takes its
  effects (start a build, read the clock, ask GitHub for the base commit, read the claim, append a line) as
  arguments, so tests run without processes or network.
- The watcher never reads or writes the build's state except the claim file, which it only reads.
- Commit messages and PR conventions as in this repo's history (`feature:`, `bugfix:`, `chore:`).

## Order of work

1. `factory watch` with config, holds and notifications, with tests. This alone can be run by hand.
2. The `deploy/` scripts and plists.
3. Install it on the Mac mini and prove it with one real design in one repo.

## Known gap, not part of this work

Heavy steps overlapping on the 16 GB Mac have already caused trouble while setting it up: `playola`'s server
tests timed out, and an iOS test run hung, each while another build was running. If real builds show the same,
the fix is to let only one agent run at a time across all repos (a machine-wide lock around the agent runner
in `lib/agents.ts`). It is left out here because it changes the build, not the watcher, and has not yet been
shown to be needed on a quiet machine.

## Left to the builder

- Names and shapes of the modules and functions.
- How the watcher reads a child's stdout and tells a `build started` from the build's stderr line or its
  report.
- The exact wording of each `summary`.
- The plist details beyond what is stated above.

## Calls made by the writer, for the owner to check

- Notifications go to a file and stdout; there is no hook command to run on each one.
- A held repo is released by a new commit on the base branch, a changed claim, or a watcher restart, with no
  new `factory` subcommand.
- `needs attention` is retried automatically, because the factory already caps it at three attempts.
- Builds for different repos run side by side; the one-agent-at-a-time lock is a known gap, not built now.
- The updater waits for agents to go quiet for up to 45 minutes, then restarts regardless.
