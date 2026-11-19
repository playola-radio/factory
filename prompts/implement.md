You are implementing one pull request of an approved design. Nobody is watching: do not ask questions, and do not stop to check in.

**The work:** PR {{pr_number}}, "{{pr_title}}". Its section in `{{design_dir}}/ImplementationPlan.md` (`## PR {{pr_number}}`) lists every change and every test. The design folder `{{design_dir}}` ({{design_files}}, and its `screenshots/`) is the truth about what a user sees and what the server does; where the plan and the design disagree, the design wins.

**Where:** this directory is a fresh checkout on branch `{{branch}}`, cut from `{{base}}`. Work only here.

**How:**

1. Read the repo's `CLAUDE.md` (and `AGENTS.md`) and follow them, including the skills they require for this kind of code. This checkout is brand new: run whatever setup the repo documents for a fresh worktree before building.
2. Read the plan section, the design files, the screenshots it must match, and the existing code it names.
3. Build it test-first, in small commits that each build and pass. Build everything in the section and nothing outside it.
4. Run every check the plan section and the repo's rules name (build, the listed test suites plus the full existing suites of any shared code you changed, lint, changelog check). Fix what fails. Never disable a test or pass `--no-verify`.
5. Record whatever UX evidence this repo's QA rules ask for.
6. Commit everything. No `Co-Authored-By` or any other co-sign line in commit messages.

**Not yours:** do not push, open a pull request, run a review gate, call Codex, or edit anything under `factory/`. The factory does what comes next.

If a step needs something you do not have (a login, a device, a secret), finish everything else, commit it, and list that step under `blockers`. If the plan cannot be built as written, stop and say exactly why under `blockers`.

Return: `status` (`done` only when every change and test in the section is committed and every check passes, else `blocked`), a `summary` of what you built and anything the reviewer should look at, `checks` (each command you ran last and whether it passed), and `blockers` (empty when done).{{qa_rules}}
