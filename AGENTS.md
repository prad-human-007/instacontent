# Codex instructions for this repo

## Caveman Lite Skill Usage

- By default, always use the [`caveman`](/Users/prad/.agents/skills/caveman/SKILL.md) skill at the `lite` intensity to reduce token usage.
- Do not use the Caveman Lite skill only when the user explicitly says not to use it.

## Validation and command policy

- Do not start a development server unless the user explicitly asks.
- Do not run `npm run dev`, `next dev`, `pnpm dev`, `yarn dev`, or any similar development-server command unless the user explicitly asks.
- Do not run `npm run build`, `pnpm build`, `yarn build`, `npm test`, `npm run lint`, or any similar validation command unless the user explicitly asks.
- The user will test all changes manually.
- After making code changes, only summarize what changed and list commands the user may want to run.
- If a command is necessary, ask the user before running it, except for the CodeGraph re-indexing rule below.

## CodeGraph re-indexing

- Use the repository's `.codegraph` index for codebase exploration.
- If code changes were made during a coding or chat session, run `codegraph index --force` at the end of the session so the CodeGraph reflects those changes.
