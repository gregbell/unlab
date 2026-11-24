# Phase 1 worker brief

The goal: an agent turns a page of text into a running lab by submitting commands, so unLAB needs machines with several
NICs, chosen addresses and names, extra disks, power control, checkpoints and file placement. Every capability is a
command-bar verb and an agent tool, through the one registry. unLAB holds no lessons, history or scenario concepts.

Rules for every slice:

- Work in this worktree on the branch that is checked out. Commit small, ordered commits with Conventional Commit titles.
  Do not push, open a PR, or touch `main`. Do not spawn subagents.
- Read `.audit/arch/synthesis.md` for the layers. `update()` stays pure and total. Plans are decided once and applied by
  the reducer. Layering is enforced by `npm run check:imports`.
- Keep a comment only for a why the code cannot show. No phase or story numbers in product code.
- Sentences a person reads follow the existing voice: short, plain, naming what would work.
- Defaults do not change: `spawn 2 alpine`, the README's first ping, saved labs from before your change still restore.
- Tests assert behavior through the user's interface. Each story box needs a test on a real kernel: an integration test
  (Node), a browser test (`src/runtime/*.browser.test.ts`) or an e2e test. Show that each new test can fail: break the
  behavior once and see it red. Pure logic also gets unit tests.
- Add a row per story box to `.audit/phase1-stories.md`: story, box, test file and test title.
- Update README command tables when a command changes, in the README's voice.
- Before you report, run and read the exit code of each: `npm run check`, `npm run test:integration`,
  `npm run test:browser`, `npm run test:e2e`. A flaky test is a finding: find out why, do not rerun until green.
- This host has no python. `grep` is ugrep. Use `node` for scripts. zig: `nix --extra-experimental-features
  'nix-command flakes' shell nixpkgs#zig --command zig ...`.
- Report: what you built, choices you made, what each new test shows and how you saw it fail, exact gate results,
  anything you could not do or are unsure of. Say plainly what is not verified.
