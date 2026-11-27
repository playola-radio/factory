You are finishing one pull request of an approved design that an earlier run left incomplete. Nobody is watching: do not ask questions, and do not stop to check in.

**The work:** PR {{pr_number}}, "{{pr_title}}". Its section in `{{design_dir}}/ImplementationPlan.md` (`## PR {{pr_number}}`) lists every change and every test. The design folder `{{design_dir}}` ({{design_files}}, and its `screenshots/` if it has one) is the truth; where the plan and the design disagree, the design wins.

**Where:** this directory, on branch `{{branch}}`, which goes into `{{base}}`. The earlier run's work is already committed here: do not redo it. `TMPDIR` is set to a private scratch folder the factory owns and deletes for you: send build and test output there, and never write large build artifacts under your home or anywhere else on the disk. {{merge_note}}

**What the earlier run reported:**

{{last_summary}}

**What is left:**

{{problems}}

Whatever blocked the earlier run may have been cleared since; the repo's rules may also have changed, so read them again and try each blocked step for real before reporting it blocked.

**How:**

1. Read the repo's `CLAUDE.md` (and `AGENTS.md`) and follow them. Run `git log origin/{{base}}..HEAD` and read what is already built.
2. Do what is left, and nothing outside the plan section except a local demo stand-in for any outside service this PR makes the app call (wired into `make demo-env` and listed in `factory/DEMO.md`). Make the bring-up check that the feature's routes answer (not 503) before it reports ready. Any video or screenshot you record for this PR goes in `$TMPDIR/evidence/`, listed in `$TMPDIR/evidence/evidence.json` as `{"files": [{"file": "<path inside evidence/, letters, digits, dots, dashes and underscores only>", "kind": "functional" | "visual", "caption": "<what it shows>"}]}`, each file under 100 MB (re-encode a longer video until it is); keep what an earlier run recorded there and add to its manifest. The factory posts exactly those files to the pull request. Before recording, confirm the demo turns the feature on (its routes answer, not 503, and nothing logs it as off); if it does not and this PR cannot make it, record nothing and report one blocker that starts with exactly `demo env does not enable this feature:` followed by what is missing.
3. Run every check the plan section and the repo's rules name again, since the branch has changed (build, the listed test suites plus the full existing suites of any shared code you changed, lint, changelog check). Fix what fails. Never disable a test or pass `--no-verify`.
4. Commit everything. No `Co-Authored-By` or any other co-sign line in commit messages; if an earlier commit has one, reword that commit to remove it.

**Not yours:** do not push, open a pull request, run a review gate, call Codex, or edit anything under `factory/` other than `factory/DEMO.md`. The factory does what comes next.

If a step still needs something you do not have, finish everything else, commit it, and list that step under `blockers` with exactly what you tried and what happened.

Return: `status` (`done` only when every change and test in the section is committed and every check passes, else `blocked`), a `summary` of the whole PR as it now stands and anything the reviewer should look at, `checks` (each command that has to pass and that you ran last, and whether it did. Leave out anything you ran expecting it to fail, such as breaking the code on purpose to prove a test catches it; describe that in `summary` instead. One `passed: false` here stops the build), and `blockers` (empty when done).
