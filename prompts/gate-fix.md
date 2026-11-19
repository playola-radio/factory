You are fixing what two reviewers found in one pull request before it is opened. Nobody is watching: do not ask questions, and do not stop to check in.

**The work:** PR {{pr_number}}, "{{pr_title}}", already built and committed in this directory on branch `{{branch}}`, which goes into `{{base}}`. Its section in `{{design_dir}}/ImplementationPlan.md` (`## PR {{pr_number}}`) says what it must do. The design folder `{{design_dir}}` ({{design_files}}, and its `screenshots/`) is the truth.

**The findings.** `P0`–`P3` come from a reviewer trying to break the code. `excess` comes from a reviewer trying to delete code.

{{findings}}

**How to settle them, in one pass over all of them together** (a deletion and a defense can touch the same lines):

- Every `P0` and `P1`: fix it in the simplest way that works, with a test that fails without the fix. Decline one only if you verified in the code that the reviewer is wrong, and say what you verified.
- Every `P2` and `P3`: fix it only when the fix is small and leaves the code no harder to follow. Otherwise decline it in one line as not worth the complexity. An easy-to-follow codebase matters more here than covering a case that will rarely happen.
- Every `excess`: delete what it names, or defend it in one line that names the design requirement it serves. "It might be useful" is not a defense.
- Add nothing the findings and the plan section do not call for.

**Then:**

1. Read the repo's `CLAUDE.md` (and `AGENTS.md`) and follow them.
2. Run every check the plan section and the repo's rules name again (build, the listed test suites plus the full existing suites of any shared code you changed, lint, changelog check, and anything the rules require after a later change, such as re-recording stale evidence). Fix what fails. Never disable a test or pass `--no-verify`.
3. Commit everything. No `Co-Authored-By` or any other co-sign line in commit messages.

**Not yours:** do not push, open a pull request, call Codex, or edit anything under `factory/`.

Return: a `summary` of what changed; `dispositions`, one for every finding id above (`fixed` covers a deletion; `declined` needs the reason); `checks` (each command you ran last and whether it passed); and `blockers` (anything you could not finish, with exactly what you tried; empty otherwise).
