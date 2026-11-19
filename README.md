# factory

Turns finished feature designs into reviewed pull requests.

You design a feature with the `design-feature` skill, which writes a folder under `factory/ready/` in the target
repo ending in an `ImplementationPlan.md`. The factory then builds that plan one PR at a time. Each PR is
implemented by one AI agent in a fresh worktree. The other vendor's agent tries to break it and audits it for
excess. The factory then opens the PR, answers the reviewers and merges once the owner approves.

> Still being made generic: the owner, bot account, Greptile and models come from a settings file (see Setup), and
> each repo's after-push command and QA rules from its own `factory/` folder. The design rules are still built into
> the `design-feature` skill.

## Install

Needs Node 24+, `git`, the GitHub CLI (`gh`), and both the `claude` and `codex` CLIs. You also need two GitHub
accounts (see Setup). Greptile is optional.

```bash
git clone <your fork or this repo's URL>
cd factory
./install.sh
```

This links `factory` into `~/.local/bin` and the skills under `skills/` into `~/.claude/skills` and
`~/.codex/skills`. `./uninstall.sh` removes those links.

## Setup

The factory needs two GitHub accounts: you (the **owner**, whose approval merges a PR) and a separate **bot**
account that writes commits, opens PRs and replies. GitHub does not let anyone approve their own PR, so one account
cannot do both, and the factory refuses a bot that is the owner (in any letter case). Sign the bot in to `gh`
(`gh auth login`, then `gh auth switch` to go back to your own account); the factory takes the bot's token from
`gh auth token --user <bot>`.

Then run:

```bash
factory init
```

It asks for your login (defaulting to the account `gh` is signed in as), the bot's login (and checks its token
works), the bot's commit name, whether Greptile reviews your repos and at what score to ask for another review, and
the Claude and Codex model names. It writes `settings.json` to `~/.config/factory/` (or `$FACTORY_HOME`). Run it
again any time; the saved values are offered as defaults. If a file is already there that is not valid factory
settings, `init` names it and stops without touching it.

`factory build` needs the settings and checks them, and that the bot's `gh` token works, before it does any work.
`factory finalize` reads them only for the models (a missing file is fine). `factory status` and `factory abandon`
never read them. A misspelt or unknown field is an error, not ignored.

```json
{
  "owner": "your-login",
  "bot": { "login": "your-bot", "name": "Your Bot", "email": "1234+your-bot@users.noreply.github.com" },
  "greptile": { "reReviewBelow": 4 },
  "models": { "claude": "opus", "codex": "gpt-6-astra" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `owner` | yes | GitHub login whose approval merges a PR |
| `bot.login` | yes | GitHub login that writes commits, opens PRs and replies; signed in to `gh`; not the owner |
| `bot.name`, `bot.email` | yes | git author name and email for the bot's commits (`factory init` fills these in) |
| `greptile` | no | present means Greptile reviews your repos |
| `greptile.reReviewBelow` | no, default 4 | integer 1-5: after a fix is pushed, ask Greptile to review again when its last score was below this |
| `models.claude`, `models.codex` | no | model passed to that CLI; when absent, no model flag is passed and the CLI's own default applies |

Notes:

- A build's PRs go into `--base`, or the branch the design was started on, or the repo's default branch on GitHub.
- Run one `factory build <repo>` per terminal, one terminal per repo. Build state is kept per repo under
  `~/.config/factory/`.
- Do not change `owner` or `bot` while a build is in progress: the review loop tells the owner's requests from its own
  replies by account. Run `factory abandon <repo>` first.

## The repo's `factory/` folder

Each repo you build keeps its designs, and optionally its own build rules, in a `factory/` folder:

```text
<repo>/factory/
  config.json       the after-push command
  qa-rules.md       the repo's evidence and QA rules, pasted into the agents' prompts
  ready/<NNN>-<name>/
  done/<NNN>-<name>/
```

Both files are optional; a repo with neither has no after-push command and no extra QA rules. The factory reads
them from the base branch as GitHub has it, never from a PR's own branch, and reads them again before each design,
so a rule merged into the base during a long build applies to the next design. Commit them to the repo by hand.

`config.json` holds the after-push command:

```json
{ "afterPush": { "command": "make ux-evidence-publish PR={pr}", "whenChanged": ".qa-artifacts/*/result.json" } }
```

| Field | Required | Meaning |
|---|---|---|
| `afterPush.command` | yes, when `afterPush` is present | shell command run in the PR's worktree once the PR is open; `{pr}` is replaced with the PR number |
| `afterPush.whenChanged` | no | glob of files in the worktree, relative and inside the repo; the command runs again only when those files changed |

The command runs once when the PR opens and, with `whenChanged`, again whenever the matched files change. Without
`whenChanged` it never runs again. If it fails, the PR needs attention, nothing more is posted or merged, and the
next `factory build` runs it again, so it must be safe to run twice. Like the settings file, an invalid or
misspelt field stops `factory build` before any work, naming the file, branch and field.

**The after-push command runs this repo's code with the bot's GitHub token.** Only put a command there that you
trust. Because it is read from the base branch, only merged code can change it.

`qa-rules.md` is plain text: what evidence the agents should record and how to check it (videos, screenshots,
which device). It is pasted as is into the prompts of the agents that implement, check and fix each PR.

## Use

```bash
factory status <repo-path>     # which designs are ready to build
factory finalize <repo-path>   # check and finish a design's implementation plan
factory build <repo-path>      # build the next design into PRs
factory abandon <repo-path>    # give up the design in progress
```

Run `factory` with no arguments for the full usage. Tests: `npm test`.
