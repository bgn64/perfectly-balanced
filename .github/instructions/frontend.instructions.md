---
applyTo: "src/**/*.{ts,tsx,css}"
description: "Frontend conventions for React, TypeScript, Tokyo Night themes, keyboard navigation, focus, accessibility, and responsive behavior."
---

# Frontend instructions

- Keep financial calculations and state transitions in pure model functions
  when they can be tested independently of React.
- Reuse semantic colors from `src/theme.css`. Do not hardcode a
  theme-dependent color in a component when a theme token already expresses
  the role.
- Preserve both dark and light Tokyo Night themes. New UI must remain legible
  and distinguish positive, negative, warning, selected, focused, and disabled
  states in both.
- Preserve the keyboard-first interaction model: semantic focus order,
  `h`/`j`/`k`/`l` spatial movement, `Enter` activation, `Escape` cancellation,
  command mode, and statusline hints must stay coherent with mouse behavior.
- Use native semantic controls and accessible names. Restore focus after
  dialogs, popovers, inline editors, and destructive confirmations close.
- Keep operational screens dense and scan-friendly. Avoid nested decorative
  cards, oversized marketing typography, and controls that shift fixed table
  or statusline geometry.
- Verify affected desktop and mobile layouts, both themes, keyboard and mouse
  workflows, responsive overflow, and browser console errors.
- Add focused Vitest coverage for changed calculations, navigation models,
  keyboard state, and regressions.