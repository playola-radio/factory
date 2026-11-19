# factory

Turns finished feature designs into reviewed pull requests.

You design a feature with the `design-feature` skill, which writes a folder under `designs/ready/` in the target
repo ending in an `ImplementationPlan.md`. The factory then builds that plan one PR at a time. Each PR is
implemented by one AI agent in a fresh worktree. The other vendor's agent tries to break it and audits it for
excess. The factory then opens the PR, answers the reviewers and merges once the owner approves.

> Still being made generic: the owner, bot account, Greptile and models now come from a settings file (see Setup).
> The `designs/` folder name, the after-PR step and the repo's QA and design rules are still built in.

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

## Use

```bash
factory status <repo-path>     # which designs are ready to build
factory finalize <repo-path>   # check and finish a design's implementation plan
factory build <repo-path>      # build the next design into PRs
factory abandon <repo-path>    # give up the design in progress
```

Run `factory` with no arguments for the full usage. Tests: `npm test`.
