---
name: manual-verify
description: Verify the Manual in docs/manual/ against the product. Use when checking a chapter's claims, screen text, synopses, or links against the code, or before Manual changes land.
---

# Verify the Manual

Verification is reading: every statement in scope is checked against the code
that makes it true. Run the app only when reading cannot settle a claim.

**Scope** is the chapters or sections the user names, or the text another
skill hands you. With none named, it is all of `docs/manual/`.

Note: in the code, the type `Manual` (`src/commands/manual.ts`) is a command's
`help` text, not this Manual.

## Checks

Apply every check to every sentence in scope.

- **Claim.** Each statement about behavior (what a command does, a default, a
  limit, what survives a reload) matches code you have read. Keep the file and
  line for the report.
- **Screen text.** Each **bold** UI string occurs verbatim in `src/ui/`, or in
  `src/model/selectors.ts` for the status line. Each quoted line of CLI output
  occurs in `cli/src/`.
- **Synopsis.** Each command entry's synopsis, and its MCP tool line, equals
  the command's line from
  `node --experimental-transform-types --no-warnings .agents/skills/manual-verify/scripts/usage.ts`.
- **Terms.** Glossary terms throughout, and no word the glossary lists under
  _Avoid_, except inside quoted screen text.
- **Style.** Every rule in `docs/manual/STYLE.md`.
- **Links.** `node .agents/skills/manual-verify/scripts/links.ts` prints
  nothing.
- **Contents and index.** `docs/manual/README.md` lists every chapter, and
  `docs/manual/index-of-terms.md` has an entry for every section in scope.
- **Getting started.** When Getting started is in scope,
  `npx playwright test e2e/manual-getting-started.spec.ts` passes.

## Then

1. **Fix the Manual** for each mismatch, so it describes the product as it is.
2. **Ticket the product** where the product itself looks wrong (wording that
   breaks the glossary, a missing control, behavior that contradicts its own
   help). Search the open issues first; open a `needs-triage` issue only when
   none covers it, following `docs/agents/issue-tracker.md`.
3. **Report** in a few lines: each change and its reason, each issue opened,
   and any claim you could not settle.

Done when every sentence in scope has been checked, and every finding is fixed
or ticketed.
