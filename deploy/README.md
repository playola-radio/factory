# Running `factory watch` on a Mac

Two launchd agents keep the watcher up and on the latest factory code:

- **`com.playola.factory-watch`** runs `factory watch` (via `run-watch.sh`), `RunAtLoad` + `KeepAlive`,
  logging to `~/.factory/watch.log`.
- **`com.playola.factory-updater`** runs `auto-update.sh` every two minutes: fetches `origin/main`, waits for any
  agent to go quiet (up to 45 min), fast-forwards this checkout, and restarts the watcher so it runs the new
  code. Restarting also clears any repo the watcher paused after a bad build. Logs to `~/.factory/updater.log`.

## Install

```bash
./deploy/install-launchd.sh      # renders both plists into ~/Library/LaunchAgents and loads them
```

Then, on this machine (neither file is in the repo):

1. `~/.factory/watch.json` — the repos to watch, e.g.
   ```json
   { "pollSeconds": 300, "repos": [ { "path": "~/playola/playola", "base": "develop" } ] }
   ```
2. `~/.factory/env` (optional) — extra environment the agents need (nvm Node, Homebrew Ruby, Java,
   `ANDROID_HOME`, Maestro). `run-watch.sh` sources it before starting the watcher.

`install-launchd.sh` and `uninstall-launchd.sh` are both safe to run again.

## Uninstall

```bash
./deploy/uninstall-launchd.sh
```
