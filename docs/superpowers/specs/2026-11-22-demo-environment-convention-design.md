# Demo environment convention — record functional evidence per `factory/DEMO.md`

## Intent / why
The factory requires a `functional` demo video as PR evidence, and `prompts/implement.md`
hardcodes recording **"on staging."** That only fits repos with a disposable staging
environment (playola). marge-web has no staging, which **blocked its design-002 PR 2**
even though all code and checks passed. Each repo knows best how to stand up a safe
environment to demo in; the factory should stay agnostic and record against whatever the
repo documents.

## Goals
- The factory records the functional video against the environment each repo documents in
  `factory/DEMO.md` — a safe, realistic, isolated **local** instance — instead of a
  hardcoded staging deploy.
- Unblock repos without staging (marge-web) **without breaking** repos that use staging
  (playola, playola-radio-android, playola-radio-ios).

## Non-goals
- Not changing *when* UX evidence is required (still only "Done when" PRs; the
  `visual` vs `functional` distinction is unchanged).
- Not building the per-repo demo environments here — each repo's `factory/DEMO.md` + any
  tooling is rolled out separately (marge-web's is already merged to main).
- Not (in this change) hardening `factory status` to refuse a repo that lacks
  `factory/DEMO.md`; noted as a follow-up.

## Anti-goals
- A demo must **never** write to production. The `factory/DEMO.md` convention requires a
  safe/isolated/read-only-sourced environment; the factory trusts the repo's documented env.

## Constraints
- `prompts/implement.md` is shared by every repo build; the wording must not break
  staging-based repos.
- Agents run unattended; any secret the demo env needs (e.g. a production DB URL) must come
  from `~/factory/secrets.env` (sourced by the watcher env), never committed.

## Approaches
- **B1 — generalize the prompt (chosen).** `implement.md` says "record against the app
  brought up per the repo's `factory/DEMO.md`," and `factory/DEMO.md` becomes a repo-level
  convention. Repo-agnostic: a staging repo documents its staging bring-up in `DEMO.md`
  (grandfathered); a local repo documents the local path.
- **B2 — name marge-web as an exception in the shared prompt (rejected).** Bakes repo names
  into the factory; ages badly as repos are added.
- **B3 — switch all repos to local-only (rejected).** Breaks playola/android/ios staging
  evidence.

## The how (decided)
1. **`prompts/implement.md` line 13** — replace the two "staging" phrases:
   - *before:* "…carries those items out from start to finish **on staging**, including the
     taps that save. … Make whatever **staging data** the flow needs to show a realistic
     screen."
   - *after:* "…carries those items out from start to finish **against the app brought up per
     the repo's `factory/DEMO.md` (its safe local demo environment)**, including the taps that
     save. … **Use the realistic data that demo environment provides** to show a real screen."
   Everything else on the line (functional vs visual, "name any item the recording does not
   show") is unchanged.
2. **Convention:** each watched repo carries **`factory/DEMO.md`** in its root `factory/`
   folder: a one-command, safe, realistic, isolated demo environment and the URL to record
   against. A repo whose only safe path is a disposable staging env documents that instead.
3. **A missing/insufficient demo env** is already covered by `implement.md`'s existing blocker
   rule (line 18: "If a step needs something you do not have … list that step under
   `blockers`"), so no new enforcement is added here.

## Left to the builder / operational (outside this one-line change)
- Put `MARGE_PRODUCTION_DB_URL` (and other repos' secrets) in `~/factory/secrets.env` and have
  the watcher env source it — required before marge-web can actually record locally.
- Merge the open DEMO.md PRs (playola #1151, android #64); create iOS's.
- Optional follow-up: `factory status` marks a repo not-buildable until `factory/DEMO.md`
  exists.

## Shipping
Single-line change to `prompts/implement.md` on branch `marge-watson/marge-web-factory-setup`
→ PR into factory `main`.
