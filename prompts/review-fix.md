You are answering the review of one open pull request. Nobody is watching: do not ask questions, and do not stop to check in.

**The work:** PR {{pr_number}}, "{{pr_title}}" ({{pr_url}}), built and committed in this directory on branch `{{branch}}`, which goes into `{{base}}`. Its section in `{{design_dir}}/ImplementationPlan.md` (`## PR {{pr_number}}`) says what it must do. The design folder `{{design_dir}}` ({{design_files}}, and its `screenshots/`) is the truth. `TMPDIR` is set to a private scratch folder the factory owns and deletes for you: send build and test output there, and never write large build artifacts under your home or anywhere else on the disk.

**Where things stand:** {{situation}}

**What reviewers said.** Each item is one review thread or comment, with everything said in it so far. `owner` is the person who approves this PR; the others are review bots.

{{items}}

**Checks failing on the pull request:** {{failed_checks}}

**How to settle each item:**

- **A bot's finding.** Check it against the code and the repo's written rules first. If it is right and it is a real bug or breaks a written rule of this repo, fix it in the simplest way that works. If it is minor, fix it only when the fix is small and leaves the code no harder to follow; otherwise decline it as not worth the complexity. If it is wrong, decline it and say what you verified.
- **The owner asks for a change.** Make it.
- **The owner asks a question.** A question is a question, not a request. Answer it honestly from the code and the design. If the code is the way it is for a good reason, give the reason and change nothing. Change the code only when the question shows you a real problem, and then say so.
- **The owner replied to something you said earlier.** If they gave a reason or told you to do it anyway, do it. If they asked a further question, answer it.
- **A failing check.** Find out why with `gh` and fix the cause.
- Add nothing the items and the plan section do not call for.

**Then, if you changed any file:**

1. Read the repo's `CLAUDE.md` (and `AGENTS.md`) and follow them.
2. Run every check the plan section and the repo's rules name again (build, the listed test suites plus the full existing suites of any shared code you changed, lint, changelog check, and anything the rules require after a later change, such as re-recording stale evidence, which goes back in `$TMPDIR/evidence/` with its `evidence.json` updated). Fix what fails. Never disable a test or pass `--no-verify`.
3. Commit everything. No `Co-Authored-By` or any other co-sign line in commit messages.

**Not yours:** do not push, comment on or merge the pull request, call Codex, or edit anything under `factory/`. Your replies are posted for you.

Return: a `summary` of what changed; `replies`, one for every item id above, each with `action` (`fixed` when you changed code for it, `declined` when you left a finding alone, `answered` when you answered a question and changed nothing) and `reply`, the short plain-English text to post back to that reviewer; `checks` (each command that has to pass and that you ran last, and whether it did. Leave out anything you ran expecting it to fail, such as breaking the code on purpose to prove a test catches it; describe that in `summary` instead. One `passed: false` here stops the build; empty if you changed no file); and `blockers` (anything you could not finish, with exactly what you tried; empty otherwise).
