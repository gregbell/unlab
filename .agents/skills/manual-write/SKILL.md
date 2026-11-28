---
name: manual-write
description: Write or revise the Manual in docs/manual/. Use when drafting a chapter, a subject section, or a command entry, or when rewording existing Manual text.
---

# Write the Manual

The Manual is the subject-based reference in `docs/manual/`. Every rule for its
text lives in [the style guide](../../../docs/manual/STYLE.md); every term in
[the glossary](../../../GLOSSARY.md).

1. **Read the rules.** Read `docs/manual/STYLE.md` and `GLOSSARY.md` in full.
   Done when you have read both end to end in this session.

2. **Find the owner.** Decide which chapter owns the subject, using
   `docs/manual/README.md`. When another chapter owns it, you write a link
   there, not the text. A subject with no fitting chapter goes to the user as a
   question.

3. **Gather the facts from the code.** Every claim you will write has a source
   you have read:
   - a command's grammar, `about` text, defaults, results, and MCP tool:
     `src/commands/verbs/<command>.ts`;
   - every synopsis and MCP tool name:
     `node --experimental-transform-types --no-warnings .agents/skills/manual-verify/scripts/usage.ts`;
   - text on screen: `src/ui/`, and the status line in `src/model/selectors.ts`;
   - CLI flags and output: `cli/src/`;
   - MCP tools with no command: `src/agent/tools.ts`.

   Done when each fact you plan to state has a file you read behind it.

4. **Write.** Write subject sections and command entries in the shapes the
   style guide sets, matching the screen word for word.

5. **Update what points at it.**
   - `docs/manual/index-of-terms.md` for every section you added, renamed, or
     removed, under every wording a reader might look for.
   - `docs/manual/README.md` when a chapter is added, removed, or retitled.
   - Every link to a heading you renamed.
   - `e2e/manual-getting-started.spec.ts` when Getting started changed.

6. **Verify.** Apply every check in
   [manual-verify](../manual-verify/SKILL.md) to the text you wrote, and fix
   what it finds. Done when those checks find nothing left to fix.
