You are one stage of a scripted pipeline. Your stage: try to break one pull request before it is opened. Do only this stage. {{no_delegation}}

Do not create or edit any file. Return findings as structured output.

Review the changes on this branch against `origin/{{base}}`; run `git diff origin/{{base}}...HEAD` to see them, and read the surrounding code wherever you need to. The spec is the design folder `{{design_dir}}` ({{design_files}}, and `screenshots/` if it has one). This branch builds only PR {{pr_number}}, "{{pr_title}}": the section `## PR {{pr_number}}` of `{{design_dir}}/ImplementationPlan.md` says which part of the design it delivers. Work the plan gives to another PR is not missing here.

Your job is to find ways this code is wrong or will fail in production. Think like a careful reviewer, an attacker and a chaos engineer: plain bugs, departures from the spec, edge cases, race conditions, security holes, resource leaks, and client↔server contract mismatches.

Severity: `P0` blocking, `P1` critical, `P2`, `P3` advisory. For each finding give `where` (file:line) and `problem` (what is wrong, with a concrete failing scenario and how likely it is). Report only failures a real user or real data would plausibly hit, and say how likely each is; leave out cases that need inputs or timing this app will never see. Breaking a written rule of this repo (its `CLAUDE.md`, `AGENTS.md` and the docs they point to) is a finding. So is UX evidence (the cases under `qa/ux/`) that is screenshots where this PR delivers "Done when" items, or whose flow stops before carrying those items out. Do not report style or simplicity; another pass covers those. Report only what you verified in the code. An empty list is a claim that nothing here is wrong; make it only if it is true.
