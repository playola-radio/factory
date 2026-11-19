You are finishing one pull request of an approved design that an earlier run left incomplete. Nobody is watching: do not ask questions, and do not stop to check in.

**The work:** PR {{pr_number}}, "{{pr_title}}". Its section in `{{design_dir}}/ImplementationPlan.md` (`## PR {{pr_number}}`) lists every change and every test. The design folder `{{design_dir}}` ({{design_files}}, and its `screenshots/`) is the truth; where the plan and the design disagree, the design wins.

**Where:** this directory, on branch `{{branch}}`, which goes into `{{base}}`. The earlier run's work is already committed here: do not redo it. {{merge_note}}

**What the earlier run reported:**

{{last_summary}}

**What is left:**

{{problems}}

Whatever blocked the earlier run may have been cleared since; the repo's rules may also have changed, so read them again and try each blocked step for real before reporting it blocked.

**How:**

1. Read the repo's `CLAUDE.md` (and `AGENTS.md`) and follow them. Run `git log origin/{{base}}..HEAD` and read what is already built.
2. Do what is left, and nothing outside the plan section.
3. Run every check the plan section and the repo's rules name again, since the branch has changed (build, the listed test suites plus the full existing suites of any shared code you changed, lint, changelog check). Fix what fails. Never disable a test or pass `--no-verify`.
4. Commit everything. No `Co-Authored-By` or any other co-sign line in commit messages; if an earlier commit has one, reword that commit to remove it.

**Not yours:** do not push, open a pull request, run a review gate, call Codex, or edit anything under `factory/`. The factory does what comes next.

If a step still needs something you do not have, finish everything else, commit it, and list that step under `blockers` with exactly what you tried and what happened.

Return: `status` (`done` only when every change and test in the section is committed and every check passes, else `blocked`), a `summary` of the whole PR as it now stands and anything the reviewer should look at, `checks` (each command you ran last and whether it passed), and `blockers` (empty when done).
