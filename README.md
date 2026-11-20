# factory

Turns finished feature designs into reviewed pull requests.

You design a feature with the `design-feature` skill, which writes a folder under `factory/ready/` in the target
repo ending in an `ImplementationPlan.md`. The factory then builds that plan one PR at a time. Each PR is
implemented by one AI agent in a fresh worktree. The other vendor's agent tries to break it and audits it for
excess. The factory then opens the PR, answers the reviewers and merges once the owner approves.

> Still being made generic: the owner, bot account, review bot and default base branch are currently built in.
> They are moving into a settings file.

## Install

Needs Node 24+, `git`, the GitHub CLI (`gh`), and both the `claude` and `codex` CLIs.

```bash
git clone https://github.com/playola-radio/factory.git
cd factory
./install.sh
```

This links `factory` into `~/.local/bin` and the skills under `skills/` into `~/.claude/skills` and
`~/.codex/skills`. `./uninstall.sh` removes those links.

## Use

```bash
factory status <repo-path>     # which designs are ready to build
factory finalize <repo-path>   # check and finish a design's implementation plan
factory build <repo-path>      # build the next design into PRs
factory abandon <repo-path>    # give up the design in progress
```

Run `factory` with no arguments for the full usage. Tests: `npm test`.

## Disk space

`factory build` needs room to work — one two-PR iOS design can use 45–50 GB of worktrees and build output.
Before it claims a design or starts any agent step (implement, a gate round, a review round), it checks the
free space on the volume holding the factory home (`$FACTORY_HOME`, default `~/.factory`). If less than the
floor is free, it refuses with a plain message saying how much is free and how much is needed, and exits 1
(a build that has nothing to build still exits 0, even on a full disk).

The floor is 20 GB by default. Override it with `FACTORY_MIN_FREE_GB`, a number of binary gigabytes (1024³
bytes), e.g. `FACTORY_MIN_FREE_GB=40 factory build <repo-path>`.

Under `factory watch`, a non-zero exit pauses that repo until the watcher restarts, so a low-disk refusal
pauses the repo: free up space, then restart the watcher.
