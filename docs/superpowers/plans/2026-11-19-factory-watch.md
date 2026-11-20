# factory watch Implementation Plan (thin scheduler)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a long-running `factory watch` command that keeps a `factory build` going for every repo in a config list, pausing a repo whose build exits non-zero until the watcher is restarted — plus the `deploy/` scripts and launchd plists to run it on the Mac.

**Architecture:** A thin scheduler. The watcher's one decision — start a build, or leave the repo alone — is a pure loop (`watch`) that takes its effects (`startBuild`, `sleep`, `log`) as an injected `WatchEffects` object, so tests run without processes. The build child is spawned with inherited stdio and read for nothing but its exit code: 0 means poll again, non-zero means pause the repo until the process restarts. No stdout/stderr parsing, no factory-state reads, no notifications (those are a separate `events.jsonl` consumer, out of scope here).

**Tech Stack:** Node 24 (TypeScript run directly, type-stripped), no dependencies, `node --test`, `node:child_process`, `bash`, launchd.

**Spec:** `docs/superpowers/specs/2026-11-19-factory-watch-design.md`

## Global Constraints

- Node 24, no dependencies, TypeScript run directly. Type-stripping only: no parameter properties, no enums, no namespaces.
- Tests in `test/` with `node --test`, in the style of `test/build.test.ts`: the watcher takes its effects as arguments.
- The watcher reads nothing from a build but its exit code, and never reads or writes factory state.
- `$FACTORY_HOME` overrides `~/.factory` (`HOME = process.env.FACTORY_HOME || ~/.factory`, as in `bin/factory.ts`).
- The watcher starts `factory build` through the same `bin/factory.ts` it was started from (`process.execPath` + this module's file), so both run the same version.
- Commit messages: `feature:`, `bugfix:`, `chore:`. No `Co-Authored-By` lines. PRs by marge-watson into `main`.

## Review Focus

- **A build killed by shutdown must not pause its repo** — but it doesn't matter, because the loop has already exited; the pause set is in-memory and discarded. The test confirms a running child is stopped and awaited at shutdown.
- **A second build is never started for a repo whose first is still running** — the running map gates it; the lock in `factory build` is a backstop, not the mechanism. Covered in the "leaves a running build alone" test.
- **A non-zero exit pauses until restart, not just one pass** — a paused repo stays paused across every later pass. Covered in the "does not restart after a non-zero exit" test.
- **A clean (exit 0) poll restarts** so a new design folder gets picked up. Covered in the "restarts after a clean exit" test.
- **`base` is required and `~/` expands** — a config with no base, or a non-git path, stops at startup with a message. Covered in the config tests.

---

## File Structure

- `lib/watch.ts` — config types + `loadWatchConfig`; `RepoConfig`/`WatchConfig`/`BuildHandle`/`WatchEffects`; the `watch` driver; `realWatchEffects`; a `realIsGitClone` helper.
- `bin/factory.ts` — add the `watch` subcommand, its USAGE line, and `--config`.
- `test/watch.test.ts` — all tests.
- Step 2: `deploy/run-watch.sh`, `deploy/auto-update.sh`, `deploy/install-launchd.sh`, `deploy/uninstall-launchd.sh`, `deploy/com.playola.factory-watch.plist.template`, `deploy/com.playola.factory-updater.plist.template`.

## Interfaces (locked)

```ts
export interface RepoConfig { path: string; base: string }           // path is absolute after loading
export interface WatchConfig { pollSeconds: number; repos: RepoConfig[] }

export interface BuildHandle { done: Promise<number>; stop(): void }  // done resolves the exit code
export interface WatchEffects {
  startBuild(repo: RepoConfig): BuildHandle
  sleep(ms: number): Promise<void>
  log(message: string): void
}

export function loadWatchConfig(text: string, isGitRepo: (p: string) => boolean, homeDir: string): WatchConfig
export function watch(config: WatchConfig, effects: WatchEffects, stop: Promise<void>): Promise<void>
export function realWatchEffects(binPath: string): WatchEffects
export function realIsGitClone(repoPath: string): boolean
```

---

### Task 1: Config loading and validation

**Files:**
- Create: `lib/watch.ts` (config types + `loadWatchConfig`)
- Test: `test/watch.test.ts`

**Interfaces:**
- Produces: `loadWatchConfig(text, isGitRepo, homeDir)`. Parses the file text; expands a leading `~/` in each repo path against `homeDir`, then `path.resolve`s it; defaults `pollSeconds` to 300. Throws `Error` naming what to fix on any problem.

- [ ] **Step 1: Write the failing tests** in `test/watch.test.ts`: defaults pollSeconds to 300; keeps a given pollSeconds; expands a leading `~/`; requires base on every repo; rejects a non-git path (naming it); rejects two entries for the same repo; rejects an unknown top-level field; rejects an unknown field on a repo; rejects a non-positive pollSeconds; rejects missing/empty repos.
- [ ] **Step 2: Run tests, verify they fail** — `node --test test/watch.test.ts`; FAIL (loadWatchConfig not defined).
- [ ] **Step 3: Implement `loadWatchConfig`** in `lib/watch.ts`.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feature: load and validate factory watch config`.

---

### Task 2: The driver, the real effects, and the subcommand

**Files:**
- Modify: `lib/watch.ts` (add `BuildHandle`, `WatchEffects`, `watch`, `realWatchEffects`, `realIsGitClone`)
- Modify: `bin/factory.ts` (add the `watch` command, `--config`, USAGE line)
- Test: `test/watch.test.ts`

**Interfaces:**
- Consumes: `RepoConfig`, `WatchConfig` from Task 1.
- Produces:
  - `watch(config, effects, stop)` — the poll loop. Keep a `running: Map<path, BuildHandle>` and a `paused: Set<path>`. Each pass, for every repo not running and not paused, `effects.startBuild(repo)`, store the handle, and on its `done`: drop it from `running`, and if not stopping and the code is non-zero, add the path to `paused` (and `log` it). Between passes `await Promise.race([effects.sleep(config.pollSeconds * 1000), stop])`. When `stop` resolves, call `stop()` on every running handle and await their `done`, then return.
  - `realWatchEffects(binPath)` — `startBuild` spawns `process.execPath [binPath, 'build', repo.path, '--base', repo.base]` with `stdio: 'inherit'` and inherited env; `done` resolves the close code (or 1 on spawn error); `stop()` sends `SIGTERM`. `sleep` = `setTimeout`. `log` = `console.error` (so it lands in `watch.log`).
  - `realIsGitClone(repoPath)` — `git -C <path> rev-parse --git-dir` succeeds.
- The driver test uses a fake `WatchEffects`: `startBuild` returns a controlled `{ done, stop }`, `sleep` counts passes and resolves `stop` after N (returning a never-resolving promise on the final pass so the loop's last await settles via `stop`), `log` collects.

- [ ] **Step 1: Write the failing tests** (fake effects; N passes then `stop`):
  - `starts a build for each repo and restarts after a clean exit` — two repos, each child resolves `done` = 0; over 2 passes, `startBuild` is called twice per repo.
  - `does not restart a repo after a non-zero exit` — one repo, child resolves `done` = 2; over 3 passes, `startBuild` is called once.
  - `leaves a running build alone across passes` — one repo whose `done` stays pending (resolves to 143 only when `stop()` is called); over 3 passes, `startBuild` is called once.
  - `stops running children on shutdown` — one repo, pending `done`; after `stop`, assert the handle's `stop()` was called and the loop returned.
  - `a clean exit for one repo does not un-pause another` — two repos, repo A exits 0, repo B exits 2; over 2 passes, A started twice, B once.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `watch`, `WatchEffects`, `BuildHandle`, `realWatchEffects`, `realIsGitClone` in `lib/watch.ts`; add the `watch` command to `bin/factory.ts` (parse `--config`, default `path.join(HOME, 'watch.json')`; `loadWatchConfig(fs.readFileSync(configPath), realIsGitClone, os.homedir())`; build `realWatchEffects` with this module's `bin/factory.ts` path; `stop` resolves on `SIGTERM`/`SIGINT`; `await watch(...)`), and add its USAGE line.
- [ ] **Step 4: Run the full suite** — `npm test`; all green.
- [ ] **Step 5: Commit** — `feature: factory watch command that builds new designs unattended`. End of PR 1.

---

## Step 2 (second PR): deploy scripts and plists

A separate branch stacked on PR 1. No unit tests (shell + launchd config); each script is safe to run again and prints what it did. Deliverables, matching the spec's "Running it on the Mac":

- `deploy/run-watch.sh` — sources `~/.factory/env` if it exists, then `exec`s `factory watch`.
- `deploy/auto-update.sh` — fetch `origin/main`; if `main` is behind, wait while any file under `$FACTORY_HOME/runs/` was written in the last 2 minutes (up to 45 minutes, then proceed and log it), fast-forward the checkout, and `launchctl kill TERM` the watcher label so KeepAlive restarts it on the new code. Logs each decision.
- `deploy/com.playola.factory-watch.plist.template` — label `com.playola.factory-watch`, runs `deploy/run-watch.sh`, `RunAtLoad` + `KeepAlive`, stdout/stderr to `~/.factory/watch.log`. Placeholder tokens for machine paths.
- `deploy/com.playola.factory-updater.plist.template` — label `com.playola.factory-updater`, runs `deploy/auto-update.sh` on `StartInterval` 120, log to `~/.factory/updater.log`.
- `deploy/install-launchd.sh` — render both templates into `~/Library/LaunchAgents` with this machine's paths, `launchctl load` them. Safe to run again (unload first).
- `deploy/uninstall-launchd.sh` — `launchctl unload` and remove both plists. Safe to run again.

Commit: `feature: launchd deploy scripts for factory watch`. PR 2.

> Step 3 (install on the Mac mini and prove it with a real design) is done in the other session, not here.
