# `factory watch`: build new designs unattended

Date: 2026-11-19. Status: approved (revised to a thin scheduler on 2026-11-19).

## Intent

The build Mac should notice when a finished design lands in any of several repos and build it, with nobody
starting anything by hand. Today `factory build <repo>` builds every ready design in one repo and then exits; it
does not watch, and it knows about one repo at a time.

The first use is the bot's Mac mini, watching `playola`, `playola-radio-ios` and `playola-radio-android` (all
cloned under `~/playola/`, all building into `develop`).

## What this is: a thin scheduler

`factory watch` is a thin wrapper. It keeps a `factory build` running for each repo in a list and does nothing
else with what the build produces. All the intelligence already lives below it:

- **`factory build` decides what to build.** It reads `factory/ready/`, claims the next design, and builds it;
  when there is nothing to build it exits 0. So the watcher never inspects design folders itself — it runs
  `factory build` and lets the build find the work.
- **`factory build` already caps its own retries.** A design that `needs attention` is retried in-process up to
  three times, then reported `stopped`. Most other bad endings (a closed PR, a gate at its round limit, a
  refused start) are reported without running an agent.
- **The factory already records everything a person would want to know** in `~/.factory/events.jsonl` (design
  claimed/finished, PR opened/merged/closed, needs attention, waiting on owner, gate results). Notifications are
  a separate consumer that tails that file. They are **not** part of `factory watch` and not part of this work.

The watcher reads exactly **one** thing from each build it starts: the process exit code. It does not parse the
build's stdout or stderr, read factory state, or write notifications.

## Goals

- One long-running command, `factory watch`, that keeps a `factory build` going for every repo in a list.
- A way to run it on the Mac so it starts on login, stays up, and picks up new factory code from `main`.

## Non-goals

- Notifications of any kind. A later, separate consumer tails `events.jsonl`; this command writes nothing there.
- Reading the build's reports, stderr, or factory state. The exit code is the whole contract.
- Changing the build itself: the review loop, the gate, the prompts, or how it caps retries.
- Watching GitHub by webhook, or watching the filesystem for folders. Polling by re-running `factory build` is
  enough.
- Pulling Playola-specific values (owner, bot account, base branch) out of the code. That is separate work.

## Anti-goals

- A stuck build retried forever. A build that ends non-zero in a way the factory would keep handing to an agent
  (a review fix that failed, a break-it pass that could not run) must not be re-kicked every poll.
- An update that kills an agent mid-implementation.

## How a build behaves today (what the watcher relies on)

- `factory build <repo> --base <branch>` fetches the base branch from GitHub into a checkout the factory owns,
  so a poll only needs the clone to exist. It reads designs from `factory/ready/`.
- It stays alive for as long as a design is in progress, including the days a PR may wait for the owner's
  approval. While waiting it only polls GitHub.
- It refuses to start if another build is running on the same repo (`build.pid` under `~/.factory/worktrees/`).
- It can be killed and started again: it continues the design in progress.
- How it ends, and all the watcher needs from it:

| Exit | Meaning |
|---|---|
| 0 | Nothing to build, or every ready design is built. A clean poll. |
| non-zero | The build stopped on something a person must look at (exit 1: cannot start, or an error; exit 2: a PR did not merge). |

## Design

### The command

```
factory watch [--config <path>]
```

It reads the config, then loops until it is told to stop (SIGTERM or SIGINT). Each pass, for every repo:

1. If a build the watcher started is still running for that repo, leave it alone.
2. If that repo is **paused** (its last build exited non-zero this run), leave it alone.
3. Otherwise start `factory build <path> --base <base>` as a child process and remember it.

When a child exits, the watcher looks at nothing but its exit code:

- **Exit 0** — a clean poll. The repo is eligible to start again on a later pass (this is how a new design in
  `factory/ready/` gets picked up).
- **Non-zero** — mark the repo paused for the rest of this watcher's life. It will not be re-kicked until the
  watcher is restarted. Restarting the watcher clears every pause; that restart is how a person says "try
  again." (On the Mac, the updater restarts the watcher whenever `main` moves, so a fix that lands in the
  factory clears the pause on its own.)

Paused repos live in memory only — a restart is the retry. The watcher never reads or writes factory state.

Builds for different repos run at the same time, each as its own child. Between passes the watcher sleeps
`pollSeconds`. On SIGTERM it passes the signal to its children, waits for them to exit, and exits. That is safe
because a build continues where it left off.

The watcher starts `factory build` through the same `bin/factory.ts` it was started from, so both always run the
same version. It spawns the child with inherited stdio, so the build's own output (its reports and the agent
trace paths it prints) flows straight to the watcher's stdout and stderr — and so into `watch.log` on the Mac —
with no capturing or parsing by the watcher.

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
300. Unknown fields, a missing file, a path that is not a git clone, or two entries for the same repo are errors
that stop the watcher at startup with a message saying what to fix.

### Running it on the Mac

Two launchd agents, in the style of `~/Projects/marge-bot`:

- `com.playola.factory-watch`: runs `factory watch`, `RunAtLoad` and `KeepAlive`, stdout and stderr to
  `~/.factory/watch.log`.
- `com.playola.factory-updater`: runs `deploy/auto-update.sh` every two minutes. It fetches `origin/main`; if
  there is something new it fast-forwards the checkout and restarts the watcher (`launchctl kill TERM`, then
  KeepAlive brings it back on the new code). Restarting the watcher also clears every pause, so a repo held
  back by a bad build gets another try on the new code.

The updater must not restart the watcher while an agent is working, since that throws away the agent's run. It
waits while any trace file under `~/.factory/runs/` has been written to in the last two minutes (agents stream
their output there), up to 45 minutes, then restarts anyway and says so in its log. A build that is only waiting
on the owner writes no trace, so it never delays an update.

The agents need a fuller environment than launchd gives them (Node from nvm, Homebrew's Ruby, Java,
`ANDROID_HOME`, Maestro). The watcher is started through `deploy/run-watch.sh`, which sources `~/.factory/env`
if it exists and then runs `factory watch`. `~/.factory/env` is written by hand on each machine and is not in
the repo.

`deploy/install-launchd.sh` writes both plists into `~/Library/LaunchAgents` with this machine's paths and loads
them; `deploy/uninstall-launchd.sh` unloads and removes them. Both are safe to run again.

## Constraints

- Node 24, no dependencies, TypeScript run directly, as the rest of the repo.
- Tests in `test/` with `node --test`, in the style of `test/build.test.ts`: the watcher's logic takes its
  effects (start a build, read the clock, sleep) as arguments, so tests run without processes or network.
- The watcher never reads or writes factory state, and reads nothing from a build but its exit code.
- Commit messages and PR conventions as in this repo's history (`feature:`, `bugfix:`, `chore:`).

## Order of work

1. `factory watch` with config and the paused-on-non-zero rule, with tests. This alone can be run by hand.
2. The `deploy/` scripts and plists.
3. Install it on the Mac mini and prove it with one real design in one repo.

## Later, separate work (not built here)

- **Notifications.** A consumer that tails `~/.factory/events.jsonl` and sends what it finds somewhere (Slack,
  etc.). The factory already writes the events; this command does not.
- **Bounding the expensive retry states in the build.** A review `fix failed` or a break-it pass that could not
  run is, today, something `factory build` would re-run an agent for on each start. The watcher's pause keeps it
  from being re-kicked, but the proper home for a cap is `factory build` itself (as it already caps `needs
  attention`). Left out here because it changes the build.
- **One agent at a time across repos.** Heavy steps overlapping on the 16 GB Mac have already caused trouble
  (server tests timed out, an iOS run hung, each while another build was running). The fix is a machine-wide
  lock around the agent runner in `lib/agents.ts`; it changes the build, not the watcher, and is not yet shown
  to be needed on a quiet machine.

## Left to the builder

- Names and shapes of the modules and functions.
- The plist details beyond what is stated above.

## Calls made by the writer, for the owner to check

- The watcher is a thin scheduler: it reacts only to a build's exit code, writes no notifications, and reads no
  factory state. Notifications are a separate consumer of `events.jsonl`.
- A non-zero exit pauses the repo until the watcher restarts; restarting (by hand, or by the updater on a new
  `main`) is the retry. There is no per-repo hold file and no new `factory` subcommand.
- Builds for different repos run side by side; the one-agent-at-a-time lock is left as later work.
- The updater waits for agents to go quiet for up to 45 minutes, then restarts regardless.
