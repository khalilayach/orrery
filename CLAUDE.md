# Project instructions

## gstack

The gstack skill suite lives at `~/.claude/skills/gstack/`. Each subfolder is a skill
with its own `SKILL.md`. Invoke a skill through the Skill tool (or the user types
`/<name>`). When a request matches a skill's purpose, invoke the skill instead of
answering ad-hoc — the skill carries the multi-step workflow and quality gates.

Available skills and how to invoke them:

- **/office-hours** — `office-hours` skill. YC-style idea/product brainstorming, two
  modes (YC founder mode and builder mode). Use for new ideas, "is this worth
  building", "help me think through this". Runs before /plan-ceo-review or
  /plan-eng-review.
- **/design-shotgun** — `design-shotgun` skill. Generates multiple AI design variants,
  opens a comparison board, collects structured feedback, and iterates. Use for
  "explore design variants", "show me design options".
- **/design-html** — `design-html` skill. Design finalization — turns an approved
  mockup or plan into production-quality Pretext-native HTML/CSS. Use for "build the
  design", "turn this into HTML", "make it real".
- **/qa** — `qa` skill. Systematically QA-tests a web app, then iteratively fixes bugs
  in source, committing each fix atomically and re-verifying. Use for "qa", "test the
  site", "find bugs".
- **/review** — `review` skill. Pre-landing PR review of the diff against the base
  branch (SQL safety, LLM trust boundaries, conditional side effects, structural
  issues). Use for "code review", "check my diff".
- **/ship** — `ship` skill. Ship workflow: merge base branch, run tests, review diff,
  bump VERSION, update CHANGELOG, commit, push, create PR. Use for "ship it", "create
  a PR", "deploy this".

There is also a `gstack` router skill: invoking `/gstack` routes a request to the
right skill in the suite.
