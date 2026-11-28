---
name: manual-maintain
description: Bring the Manual in docs/manual/ up to date with a product change. Use when a branch or PR changes commands, text on screen, CLI flags or output, MCP tools, limits, or defaults, or after finishing such a feature.
---

# Maintain the Manual

The Manual changes in the same branch as the product change that affects it.

1. **Read the change.** The branch's diff against `main`
   (`git diff main...HEAD` plus uncommitted work), or `gh pr diff <number>` when
   the user names a PR.

2. **List what a reader would notice.** Every change to a command's grammar,
   `about` text, defaults, results, or MCP tool; to text on screen; to CLI flags
   or output; to limits, defaults, or what survives a reload. Done when every
   file in the diff is either on the list or plainly invisible to a reader
   (tests, refactors, build).

3. **Find each one in the Manual.** Search `docs/manual/` for the command, the
   old string, flag, or tool name, and check the chapter that owns the subject
   in `docs/manual/README.md`. A new feature with no section goes in its owning
   chapter. A subject with no fitting chapter goes to the user as a question. A
   chapter not written yet is skipped.

4. **Update.** Follow [manual-write](../manual-write/SKILL.md) for each
   affected section, including its verify step.

5. **Report** each change on the list: the section that now covers it, or why
   the Manual does not.

Done when every change on the list is accounted for in the report.
