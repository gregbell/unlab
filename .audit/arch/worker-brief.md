# Worker brief: rules for every implementation worker

The goal of the whole effort: turn the unlab prototype into the production unlab.dev app the designer specified in `/home/greg/Downloads/unlab-design/HANDOFF.md`, as production-ready, well-tested, maintainable TypeScript. You own one slice of it. Do it as a senior engineer would, to a standard you would merge.

## Read first

1. `/home/greg/src/unlab/.audit/arch/synthesis.md`. The architecture contract. It wins over everything else.
2. `/home/greg/src/unlab/src/model/types.ts`. The shared types. Do not change existing names or shapes. You may add a type if your slice needs one, and you must say so in your report.
3. The candidate-3 sketch file for your slice, in `/home/greg/src/unlab/.audit/arch/candidates/candidate-3/sketch/`. Its signatures and doc comments are the starting point. Its `not implemented` bodies are yours.
4. The handoff sections your brief names.

## Rules

- Stay inside the paths your brief gives you. Another worker owns every other slice in parallel. If you need something outside your scope, write a local stand-in in your tests and name the need in your report.
- Tests first where the behaviour is specified: write the test from the handoff's words, watch it fail, then implement. Assert what a caller observes, never private helpers. Derive expected values from the spec, not from running the code. Use `fast-check` for properties the brief names.
- Unit tests sit beside the code as `*.test.ts` and run under `npx vitest run --project unit` in Node. No DOM, no timers you don't inject.
- TypeScript strict. No `any`, no non-null `!`, no casts except at a parsing boundary with a comment saying why. No decorators. Prefer discriminated unions and readonly data.
- Comments only for a non-obvious why. No section banners, no narrating comments, no commented-out code.
- Formatting and lint: Biome (`npx biome check --write <your paths>`).
- Before you finish, all of these must pass in your worktree: `npm run typecheck`, `npx biome check .`, `npx vitest run --project unit`, `npm run build`.
- Commit your work on your worktree's branch with a clear message that ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Leave the tree clean.

## Report

Reply with: the branch name and commit SHA; the public API you exported (signatures only); every place you deviated from the sketch or added a type, and why; the test count and the exact commands you ran with their results; anything you could not do.
