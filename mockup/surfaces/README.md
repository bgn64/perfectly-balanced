# Canonical surface contracts

Each user-facing product surface gets one approved contract:

```text
mockup/surfaces/<surface>/
  index.html
  contract.yaml
```

Start from
`.github/skills/mockup-contract/assets/contract-template.yaml`. The surface
mockup may reuse `../../neovim-tokyonight.css` and existing review-frame styles.

The top-level mockups for authentication, configuration, Budget, Transactions,
and Reports predate the contract workflow. They remain design references and
must not be treated as approved implementation contracts. Migrate only the
surface being changed:

1. Inspect the running app in both themes and at the required viewports.
2. Copy only the current states for that surface into its canonical folder.
3. Record those states and deterministic fixtures as `reconciled`.
4. Commit that baseline before proposing a visible change.
5. Link the canonical surface from `mockup/index.html` without removing the
   remaining legacy review pages.

Do not promote a legacy page wholesale when it mixes current, exploratory, and
proposed states.