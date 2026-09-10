---
name: mockup-contract
description: >-
  Reconcile, design, approve, and implement canonical UI mockups. Use for any
  user-facing UI change, new screen, redesign, responsive change, theme change,
  dialog, keyboard interaction, or mockup maintenance.
---

# Mockup contract

Use one canonical mockup per product surface. The approved mockup is the exact
visual and behavioral contract for implementation.

## 1. Discover

Read repository instructions, then identify the smallest product surface,
owning route/components, app URL, local fixture, mockup page, relevant themes,
viewports, and UI automation tools.

Perfectly Balanced defaults:

- App: `npm run dev`, `http://localhost:5173`.
- Mockup server beside the app: `npm run mockup:serve`,
  `http://localhost:4174`.
- Local account: `dev@example.test` / `local-dev-password`.
- Canonical surface: `mockup/surfaces/<surface>/`.
- Catalog: `mockup/index.html`.
- UI automation: the repository `ui-automation` MCP.

## 2. Reconcile current state

Before designing, inspect the running app at the contract's viewports, themes,
states, and interactions. Reconcile the canonical mockup to current behavior
without the requested change.

If the surface has only a legacy top-level mockup, migrate just that surface.
Keep existing legacy pages as references until their surfaces are touched.

Record a `reconciled` contract and commit this baseline separately. Ask before
the baseline commit unless the user already authorized end-to-end delivery.

## 3. Design and approve

Update the canonical mockup and `contract.yaml`. Record:

- route and owning components;
- desktop and mobile viewport sizes;
- dark and light theme states;
- loading, empty, error, success, dialog, and focus states relevant to the
  change;
- keyboard and mouse interactions with visible outcomes;
- deterministic local fixture scenarios;
- interaction fidelity: `static`, `simulated`, or `functional`.

Set status to `proposed`. Iterate until the user explicitly approves it. Then
set status to `approved` and commit the approved design separately. Do not
implement before approval.

## 4. Implement the approved contract

Make the app match every approved state and interaction. Use
`.github/skills/tokyo-terminal-design-system/SKILL.md` for visual and keyboard
conventions. Do not change the mockup to accommodate implementation.

## 5. Verify and finish

Run the repository checks and use the real local app, Supabase fixture, mouse,
and keyboard. Compare against the mockup in both themes and contract viewports.
Inspect focus restoration, responsive overflow, fixed geometry, and browser
console errors.

Set status to `implemented` and record files and verification outcomes in the
contract. Keep baseline, approved design, and implementation as distinct
commits inside the feature PR.