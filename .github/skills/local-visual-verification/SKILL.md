---
name: local-visual-verification
description: >-
  Verify Perfectly Balanced UI against canonical mockups using the Docker-backed
  local Supabase fixture and browser automation. Use for UI comparison,
  responsive/theme checks, keyboard workflows, screenshots, or console errors.
---

# Local visual verification

## Start the environments

1. Start the real app with `npm run dev`. Its `predev` hook starts local
   Supabase and generates `.env.development.local`.
2. Open `http://localhost:5173` and sign in with
   `dev@example.test` / `local-dev-password`.
3. Start canonical mockups with `npm run mockup:serve` and open
   `http://localhost:4174`.
4. Use the repository `ui-automation` MCP. Do not send credentials or secrets
   through chat; the local fixture credentials are non-secret and committed.

Use `npm run local:reset` when a deterministic fixture must be restored.
Never enable local demo mode against a hosted Supabase URL.

## Comparison loop

1. Capture the approved mockup state and the matching running app state.
2. Enumerate concrete differences in geometry, typography, color role, state,
   focus, copy, and behavior.
3. Make a coherent implementation batch.
4. Re-run the narrowest executable check, then compare the app again.

For each contract state verify:

- approved desktop and mobile viewports;
- dark and light themes;
- mouse and keyboard workflows;
- semantic and visible focus plus focus restoration;
- loading, empty, error, success, modal, and command states;
- horizontal and vertical overflow;
- table, HUD, dialog, and statusline geometry;
- browser console and failed network requests.

Screenshots are evidence, not the only check. Measure layout or pixels for
fixed-format elements and inspect accessible roles/names for interactions.