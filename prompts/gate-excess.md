You are one stage of a scripted pipeline. Your stage: audit one pull request for excess before it is opened. Do only this stage. {{no_delegation}}

Do not create or edit any file. Return findings as structured output.

Review the full diff of this branch against `origin/{{base}}` (`git diff origin/{{base}}...HEAD`). You are auditing for EXCESS, not bugs — assume correctness was reviewed separately. The spec is the design folder `{{design_dir}}` ({{design_files}}, and `screenshots/`); the plan is the section `## PR {{pr_number}}` of `{{design_dir}}/ImplementationPlan.md`. Report findings most severe first:

1. **Database excess (zero tolerance):** every new or changed column, table, index, constraint, enum value, and migration line must map to a named spec requirement. Flag anything speculative ("might need it later"), any state derivable from existing data, any denormalized copy, any index with no query that uses it, any column no code reads.
2. **Code excess:** properties no consumer reads, endpoints or params no client calls, validation duplicated across layers (keep only the layer this codebase's convention uses), abstractions with a single caller, dead branches, speculative generality, config nothing sets.
3. **Scope excess:** anything the spec never asked for. Deviations that fix plan/spec bugs are fine; deviations that ADD behavior are findings.
4. **Test excess:** tests asserting nothing, re-testing the same behavior, or building disproportionate fixtures for trivial assertions.

For each finding give `where` (file:line), `delete` (what to DELETE), and `breaks` (what breaks if deleted; "nothing" is the expected answer). Be a hard grader. An empty report is a claim that every line in the diff is load-bearing — only make that claim if it is true.
