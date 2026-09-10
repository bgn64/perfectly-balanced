---
applyTo: "mockup/**"
description: "Rules for canonical mockup contracts, legacy review pages, design states, themes, viewports, focus, and approval status."
---

# Mockup instructions

- Load `.github/skills/mockup-contract/SKILL.md` before changing a product
  surface.
- Canonical product contracts live at `mockup/surfaces/<surface>/index.html`
  with a sibling `contract.yaml`. Link each surface from `mockup/index.html`.
- Existing top-level review pages are legacy references. Migrate only the
  surface being changed; do not reorganize unrelated mockups.
- Preserve the shared Tokyo Night mockup stylesheet and existing review-frame
  patterns unless a canonical surface needs isolated interaction code.
- Record realistic fixtures and every state needed to judge the change,
  including desktop/mobile, dark/light, loading/empty/error, dialogs, keyboard
  focus, command mode, and responsive overflow when relevant.
- Use status `reconciled`, `proposed`, `approved`, or `implemented`. Do not
  implement a proposed design before explicit user approval.
- Never modify an approved mockup to excuse implementation drift. Revise the
  design, get approval again, and commit that revision before implementation.