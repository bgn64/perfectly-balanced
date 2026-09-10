---
name: tokyo-terminal-design-system
description: >-
  Perfectly Balanced's Tokyo Night terminal UI system. Use when implementing or
  restyling UI, changing themes or CSS tokens, building layouts and dialogs,
  modifying the HUD/statusline, keyboard focus, responsive behavior, or mockups.
---

# Tokyo terminal design system

The approved canonical surface mockup is the visual contract. This skill maps
that contract to the existing React/CSS system.

## Token authority

- `src/theme.css` owns dark and light semantic tokens.
- `src/terminal.css` owns the terminal shell and reusable interaction styling.
- `src/App.css` owns application layout and feature-level component styling.
- `mockup/neovim-tokyonight.css` mirrors the product language for review pages.

Use semantic roles such as accent, canvas, chrome, surface, raised surface,
selection, border, text, muted text, positive, negative, warning, secondary,
overlay, and shadow. Add a token to both themes instead of hardcoding a
theme-dependent component color.

## Product character

- This is a focused financial tool, not a marketing site. Prefer dense tables,
  stable columns, compact controls, and information that supports repeated
  scanning and editing.
- Preserve the titlebar, sidebar, workspace, HUD, command panel, and statusline
  hierarchy. Do not turn page sections into floating cards or nest decorative
  cards.
- Keep money and table numerics aligned and stable. Dynamic values, focus
  outlines, badges, and loading text must not resize fixed geometry.
- Positive, negative, warning, selected, and focused states must remain
  distinguishable without relying only on hue.

## Keyboard and accessibility contract

- Mouse and keyboard operate the same semantic controls.
- Preserve spatial `h`/`j`/`k`/`l` navigation, `Enter`, `Escape`, command mode,
  and accurate statusline hints.
- Dialogs and popovers trap focus when open and restore it to the invoking
  control on close.
- Use native buttons, inputs, tables, headings, labels, and ARIA relationships.
- Verify browser focus, semantic focus styling, visible focus, disabled states,
  and screen-reader names.

## Responsive and theme verification

Verify every changed surface at its approved desktop and mobile viewports in
both `data-theme="dark"` and `data-theme="light"`. Check text clipping,
horizontal overflow, table behavior, dialogs, the statusline, and console
errors. Measure fixed geometry when screenshots alone are ambiguous.