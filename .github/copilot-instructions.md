# Repository development workflow

Use this workflow for changes to application source, configuration, database
schema or migrations, infrastructure, tests, and documentation. Scale the
depth of investigation and validation to the risk of the change.

## 1. Understand the change

- Start from the most concrete anchor: the reported behavior, failing check,
  owning component, query, migration, or nearby test.
- Follow wiring only as far as the code that directly controls the behavior.
- Before editing, state one falsifiable local hypothesis, one inexpensive check
  that could disprove it, and the smallest change that would test it.
- Preserve existing conventions and avoid unrelated refactors.

## 2. Approve user-visible changes

- For changes that affect visible UI, create or update realistic mockups before
  changing application UI source.
- Cover the states affected by the request, including relevant desktop and
  mobile layouts, light and dark themes, empty/loading/error states, modals,
  focus states, and keyboard interactions.
- Get explicit user approval of the visible design before implementation.
- Skip the mockup gate for behavior-only, backend, test, documentation, and
  read-only work that does not change the visible design.

## 3. Implement incrementally

- Make the smallest grounded edit first. Immediately run the narrowest
  executable check that can falsify the hypothesis before widening the change.
- If that check fails, repair the same slice and rerun it before moving on.
- Prefer pure domain logic separated from rendering and interaction state when
  the behavior benefits from direct tests.
- Reuse existing abstractions, semantic navigation attributes, design tokens,
  data access patterns, and component conventions.
- Add focused tests for calculations, state transitions, regressions, and edge
  cases. Let coverage grow with the change's risk and blast radius.

## 4. Validate the real workflow

- For UI work, test the running application rather than relying only on static
  markup. Exercise the affected workflow with mouse and keyboard.
- Verify relevant viewport sizes, themes, loading/empty/error states, modal
  behavior, focus movement and restoration, responsive overflow, and browser
  console or page errors.
- For fixed visual geometry, measure layout or pixels as well as taking
  screenshots. Confirm that controls and text do not overlap.
- Before delivery, run the repository's relevant tests, typecheck, lint,
  production build, and `git diff --check`. Report any check that could not run
  and any non-blocking warnings.

## 5. Deliver cleanly

- Keep branches, commits, and pull requests focused on one behavior. Never
  include unrelated working-tree changes.
- For UI work, preserve approved mockups with the implementation so reviewers
  can compare intent and result.
- Before pushing, inspect the final diff. If the target branch advanced or the
  change was rebased or cherry-picked, rerun executable validation afterward.
- When requested, push normally and create a pull request summarizing behavior,
  tests, and browser validation.
- If the original pull request has already merged, branch from current
  `origin/main`, cherry-pick only the follow-up commit, revalidate, and open a
  separate pull request. Never force-push a merged branch into delivery.

For user-visible UI work, the default loop is:

**observe -> mock up -> approve -> hypothesize -> edit narrowly -> validate ->
browser-test -> inspect diff -> commit -> pull request -> refine from feedback**

For other work, begin at **hypothesize -> edit narrowly -> validate** and use
the same inspection and delivery steps.
