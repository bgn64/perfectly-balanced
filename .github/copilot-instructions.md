# UI-first change workflow

For every user request that may modify application source, configuration,
database schema or migrations, infrastructure, tests, or documentation, invoke
the `ui-first-feature-development` skill before planning or editing files.

Do not invoke the skill for pure explanations, read-only investigation, or
read-only review. If a request could affect user-visible UI, follow the skill's
mockup approval gate before reading or changing application source.
