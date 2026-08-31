---
name: ui-first-feature-development
description: Mandatory workflow for every request that may modify this application's source, configuration, database schema or migrations, infrastructure, tests, or documentation. Use before planning or editing. It classifies UI impact, requires mockup approval before UI code inspection, then requires implementation-plan approval before any change.
---

# UI-first feature development

Use this workflow for every change-making request in this repository. Do not use
it for pure explanations, read-only investigation, or read-only review.

## Phase -1: Git preparation

Before classifying the request, reading application code, or modifying any
file:

1. Run `git status --short --branch`. Require a clean working directory. If it
   contains changes, stop and ask the user how to handle them. Do not discard,
   stash, reset, rebase, commit, or incorporate pre-existing changes without
   explicit user direction.
2. Fetch the current main branch from the configured remote, then create and
   check out a new, task-specific branch based on the fetched `origin/main`.
   Do not implement changes directly on `main` or reuse a prior task branch.
3. Confirm the new branch is clean before continuing.

## Phase 0: classify UI impact

Before reading or changing application source, classify the requested outcome:

- **UI-impacting:** It changes any user-visible screen, page, navigation,
  content, label, control, layout, visual state, responsive behavior, or
  interaction affordance.
- **Non-UI:** It has no user-visible change.

If uncertain, classify the request as UI-impacting.

## UI-impacting work: mockup approval gate

Until the user approves the visual proposal:

1. Work exclusively within `mockup/`. Do not read, edit, or inspect
   application source, backend code, migrations, configuration, tests, or
   deployment files.
2. Update the static mockup to show every affected screen and visible state.
   The mockup is a current-state source of truth, not a version archive:
   replace outdated markup rather than creating `v1`, `v2`, dated copies, or
   alternate designs.
3. Keep mockups static. HTML and CSS navigation, hover, focus, and other
   presentational behavior are allowed. Do not add JavaScript, authentication,
   APIs, database calls, network calls, backend behavior, Plaid Link, or
   application functionality.
4. When more than one HTML page is needed, provide obvious shared navigation
   so pages form one connected mockup rather than unrelated files.
5. Open the static HTML file directly in the browser with its `file:///` URL.
   Do not run `npm run mockup`, Vite, or any other background server for a
   static mockup. First use UI automation to find and reuse an existing
   browser tab reserved for inspection; navigate that tab rather than opening
   a new tab.
6. Stop. If the user rejects or revises the visual proposal, update only
   `mockup/`, reload the same direct-file tab, and request approval again.

Never start the implementation plan or inspect application code before explicit
mockup approval.

## Implementation-plan approval gate

After mockup approval for UI work, or after Phase 0 for non-UI work:

1. Read only the application areas relevant to the approved request.
2. Create a scoped implementation plan before making changes.
3. Explicitly identify every backend and data effect. Include a table that
   states each database migration, schema/table/function/RLS/policy change,
   data backfill or deletion, secret/configuration/deployment change, and
   rollback consideration. State **None** for each category that has no
   change.
4. Request explicit plan approval and stop.

Do not implement code, configuration, migrations, tests, or documentation until
the user approves this plan.

## Implementation and visual parity

After plan approval:

1. Implement only the approved scope.
2. For UI work, reproduce the approved mockup exactly in the working app:
   hierarchy, copy, controls, visible states, layout, spacing, colors,
   typography, hover/focus treatments, and responsive behavior. Do not
   silently reinterpret or improve the approved visual design.
3. Before implementation, create an element-by-element parity checklist that
   maps each approved mockup element and visible state to its production owner.
   A familiar layout, comparable colors, or reused component is not enough:
   any difference in hierarchy, copy, control inventory, spacing, color,
   typography, focus treatment, state, or responsive behavior is incomplete.
4. Commit the matching `mockup/` update in the same change set as every
   UI-changing feature. The static mockup must remain a faithful one-to-one
   reflection of the current working app.
5. If implementation exposes a necessary visible change that differs from the
   approved mockup, return to the mockup approval gate before proceeding.

## UI smoke testing

For UI changes, run the relevant local application server and use the
`ui-automation` MCP for browser navigation, screenshots, interactions, and
visible-state assertions:

1. First check whether the `ui-automation` MCP and suitable browser tools are
   available. If unavailable, notify the user that the required UI smoke test
   is blocked. Do not substitute another automation service and do not claim
   complete UI validation.
2. Reuse the same browser tab used for direct-file mockup inspection. Navigate
   it to the running application URL; do not open additional application or
   mockup tabs. Capture mockup and application screenshots at the same
   viewport, then compare them against the element-by-element parity checklist.
   Cover the affected screens, text, controls, empty/loading/error states,
   layout, spacing, hover/focus treatment, and narrow viewport behavior.
3. Treat all Plaid bank-connection controls in the running app as live
   production operations. Until a separate local or staging Plaid integration
   is explicitly added and approved, never click or invoke **Connect bank**,
   **Reconnect bank**, **Check available transactions**, **Disconnect bank**,
   or **Delete saved history**. Never complete Plaid Link, submit bank
   credentials, authorize an institution, create/delete/synchronize a Plaid
   Item, or mutate real transaction data through UI automation.
4. Test Plaid-related UI only through the static mockup or non-destructive
   rendered-state assertions. Do not present an unexecuted Plaid control as
   smoke-tested.

## Completion

Before reporting completion:

- confirm the mockup and application match for every item in the approved
  parity checklist;
- confirm matching mockup files are included in the same change set;
- report any blocked `ui-automation` smoke test plainly;
- report database and backend changes specifically, including migrations and
  data effects.

Finish every change-making task by:

1. confirming the task branch contains only the intended changes;
2. creating a scoped commit that follows repository commit conventions;
3. pushing the new branch, but not creating a pull request yet;
4. starting at most one relevant local application server, confirming it is
   reachable, and reusing the existing inspection tab to leave the working app
   open for the user. Never launch duplicate servers or browser tabs. For UI
   work, leave the working app open rather than only the static mockup. If the
   app cannot run locally, state the exact blocker instead of claiming it was
   left available.
5. waiting for the user to explicitly confirm that they have verified the
   final changes and are ready to publish. Only then create one pull request
   against the latest `main`.
