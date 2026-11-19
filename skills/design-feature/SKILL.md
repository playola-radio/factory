---
name: design-feature
description: Use when starting a new feature or changing an existing one, BEFORE any implementation code, and when a design folder needs its implementation plan — "design X", "let's design it first", "start a design PR", "plan design 001", "finish the design". Produces one numbered folder in factory/ready/ (screens, contract, model changes, implementation plan) shipped as one design PR, which is the only thing the factory will build from.
---

# Design Feature

One conversation with the owner that ends in one folder the factory can build without asking anything:

```text
factory/ready/<NNN>-<kebab-name>/
  Design.md               always
  screenshots/            always; <screen>--<state>.png
  ApiContract.md          only if the design calls any endpoint
  ModelChanges.md         only if a stored model changes
  ImplementationPlan.md   written here with the owner, then finished by `factory finalize`
```

No application code is written here. The folder is the truth: every decision made in chat is written into it before moving on.

`factory status <repo>` names anything wrong with a folder's shape or plan; run it whenever unsure. If `factory` is not on the PATH, run `./install.sh` from the factory repo.

If the folder already exists and only lacks a finished plan, read `factory/design-rules.md` if the repo has one and follow it, then go to step 8.

## 1. Set up

- **Base branch:** the one the owner names (a feature branch such as `feature/<name>`), else the repo default from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`. Never `main` in a repo whose default is `develop`.
- **Fresh base:** `git fetch`, tree clean, and the branch is the base or freshly cut from it. If not, stop and say so; never reset, merge or switch on your own. Work on `<author>/design-<name>`.
- **Repo rules:** read `factory/design-rules.md` if the repo has one, and follow it for the rest of the conversation. It says where the backend lives, which docs to read, how screens are drawn and exported, and what to commit with the folder.
- **Backend:** if the models and endpoints this design touches live in another repo, `design-rules.md` says where; read them there and record that repo's SHA in `Design.md`.
- **Screens:** drawn the way `design-rules.md` says. Without one, ask the owner how they will supply each screen as a PNG. Never skip the screens silently.

## 2. Scope one slice

Push back until you agree what is built and what is not. Then cut it: one design is one thin path a user can complete end to end (create → act → see the result), not a layer. The first slice is this design; each later slice is its own numbered folder later. `<NNN>` is the next free number across `factory/ready/` and `factory/done/`; numbers are the build order.

Record in `Design.md`: who uses it, the intent in two sentences, what is out of scope, and for every list the realistic upper size (hundreds of rows, not three).

## 3. Read what exists

Only what this slice touches: the docs `design-rules.md` names, the current screens, and the code those screens run on. If the slice replaces a working screen, read that screen's page, model, service, route and tests first, so proven behaviour is kept on purpose.

## 4. Screens, one at a time

Ask how many layout directions to explore (3–4 for something substantial, 1–2 for something small). Then draw one screen, wait for the owner's explicit approval, and only then draw the next. New frames follow any layout rules in `design-rules.md`; reuse existing components.

Every screen is drawn or described in each state it can be reached in: **a brand-new unsaved item**, loading, empty, error, and locked or forbidden. Lists are drawn at their real size, with the search or scrolling that implies. Copy is functional (no greetings or encouragement), and primary actions outrank secondary ones visually.

## 5. Contract and models

- **`ApiContract.md`:** every endpoint the design calls, including unchanged ones and the ones existing code already makes on the same path (creating the item, loading it). Each has its method and path, which repo owns it, `unchanged` / `changed` / `new`, and real request and response JSON copied from the backend's docs. Client-side model changes go here too.
- **`ModelChanges.md`:** every stored field added, changed or removed, with type, nullability, where its value comes from, and the migration or backfill it implies. Default to no new field: anything derivable from existing data is not stored. List the fields you considered and left out, with why.
- Backend conventions: those in `design-rules.md` and the backend's own docs; one source of truth for anything that can change.

## 6. Audit before planning

Check every screen against the code, and write down what you checked:

1. **Consistency** with existing navigation, naming, components and endpoint shapes.
2. **Completeness:** whatever can be created can be edited and removed; no dead ends; every state in step 4 is covered.
3. **Fewer screens and inputs:** anything the system already knows is prefilled, never asked.
4. **One source of truth** for every changeable value; nothing copied.
5. **Fewest fields**, and what will hurt when the model is extended.
6. **Copy and density** at the sizes from step 2.

Fix what the code or the conventions already answer. Everything else is the owner's: ask one at a time with option A, option B, your recommendation and the cost of being wrong — never "what do you think?". A choice is the owner's whenever it changes what a user can see, delete, recover or publish, implies a migration, or changes which repos are involved.

Write each answer into `Design.md` under `## Decisions`, and correct the screens and contract to match.

## 7. Write `Design.md` and export

`Design.md` holds, in order: title `# <NNN> — <Name>`, the step 2 record, `## Screens` (one `###` per screen and state, with its image link `![…](screenshots/<screen>--<state>.png)`, its address, and how it is reached and left), `## Decisions`, and `## Done when`: a `- [ ]` checklist where each line is one outcome a user could check on a device.

Save every approved screen as a PNG in `screenshots/`, named `<screen>--<state>.png`, the way `design-rules.md` says. Every file there must be linked from `Design.md`.

## 8. Implementation plan

Read the code the design builds on, then write `ImplementationPlan.md` with the owner. Anything the design does not settle is a question for the owner (option A, option B, recommendation), and the answer goes into the design files, not only the plan.

Cut the work into PRs built in order. Each leaves the app building with tests passing and can be reviewed on its own. Avoid tiny PRs: every PR costs a full review, and one PR for a small design is fine. The plan adds nothing the design does not ask for. It names the base branch and any repo bookkeeping the PR must do.

The factory reads the PRs back out of this file, so keep the layout exactly:

```markdown
# <NNN>-<name> — Implementation plan

The design files beside this plan are the truth; this plan only says how to build them.

<the approach in a short paragraph, and the decisions made while planning>

| PR | Title | Depends on | Hard |
|---|---|---|---|
| 1 | feature: <plain English> | — | no |
| 2 | feature: <plain English> | 1 | yes |

## PR 1 — feature: <plain English>

<two or three sentences: what a user can do once this is merged>

**Changes**

- <one step per line, naming the real files and types, so the implementer makes no design decisions>

**Tests**

- <one specific test case per line>

**Screenshots it must match**

- `screenshots/<screen>--<state>.png`

**"Done when" items it delivers**

- 3. <the checklist line; the number is its position in `## Done when`>
```

Titles start with `feature:`, `bugfix:` or `chore:` and use no code names. Every screenshot and every "Done when" item belongs to exactly one PR; an empty list is `- none`. `Hard` is `yes` only for a subtle correctness or concurrency problem.

## 9. Finalize

When the owner is happy with the plan, run this and wait for it; the review takes several minutes:

```bash
factory finalize "$(git rev-parse --show-toplevel)" <NNN> --author <claude|codex, whichever you are>
```

It checks the file's shape for free, has the other vendor review the plan against the design and the code, and marks the plan finished.

- **Exit 0, `finished`:** done. Confirm `factory status` shows `"buildable": true`.
- **Exit 2, `plan needs fixing`:** a shape problem; fix the file and run it again.
- **Exit 2, `review found problems`:** show the owner every finding with your view of whether it is right. Fix the plan, or the design when the gap is there, then run it again. A finding you believe is wrong is the owner's call, not yours.
- **Exit 1:** it broke; show the owner the error.

Any later edit to the design or the plan undoes the finish; run finalize again. Never write the `<!-- factory: … -->` line yourself.

## 10. Ship

When the owner approves the folder: commit it, with any design file `design-rules.md` says to commit, and open one PR to the base branch, titled `design: <plain English>`, through the normal PR flow. The factory builds from the folder once that PR is merged.

## Rules

- One slice, one folder, one branch, one PR.
- A decision that is only in chat does not exist.
- If the owner asks to skip the screens or the audit, say once what that risks, then comply and record the skip in `Design.md`.
- A folder that `factory status` calls not buildable is never handed off as ready.
