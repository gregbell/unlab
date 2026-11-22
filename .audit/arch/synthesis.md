# Architecture synthesis: the contract for the rewrite

The goal: turn the unlab prototype into the production unlab.dev app specified in `/home/greg/Downloads/unlab-design/HANDOFF.md`, with production-ready, well-tested, maintainable TypeScript.

This file is the contract every implementation step builds against. The full candidate packages are in `.audit/arch/candidates/`. The base is **candidate 3** (`candidates/candidate-3/design.md` and `sketch/*.ts`); read it for detail this file does not repeat. Where this file and a candidate disagree, this file wins.

## Synthesis decision

- **Base: candidate 3.** Rubric (`rubric.md`), scored 1-5 per criterion, C1 / C2 / C3:
  1. One owner, one path: 3 / 4 / 5. C1 splits facts between a runtime facade and a reducer projection, so allocation lives twice. C2 and C3 keep all policy in the reducer; C3's `Plan` object is read by preview, approval and reducer alike, and its `Approval` token makes "danger needs a confirmation" a compile error.
  2. Pure, testable domain: 3 / 5 / 5.
  3. Hot paths: 5 / 5 / 5. All three put frames in a ring outside the reducer with one notification per animation frame.
  4. Reader load: 4 / 3 / 4. C2's reconciler diffs desired against actual state, which is indirect to trace. C3's effects are explicit, ordered data the tests assert on.
  5. Fits the runtime: 4 / 5 / 4. C3's off-screen "garage" for terminals is an unproven WTerm behaviour; C2's "panes never move" avoids it.
  6. Incremental delivery: 5 / 4 / 4.
- **Convergence.** All three independently chose: a total, idempotent reducer over a discriminated event union; frames and terminal bytes bypassing the reducer; Lit 3 without decorators in light DOM (ARIA IDREFs and wterm's global CSS); one WTerm per session for the session's life; line marks as wterm tracked positions; OSC 133 in the guest prompt for exec exit codes and busy detection, with a sentinel fallback; pure `settle`/`reconcilePanes`; a grammar derived from declared params; agent tools derived from the verb registry. That agreement is strong signal; these are settled.
- **Cross-judge: skipped.** The configured pool (`fable medium, opus medium, inherit-parent`) is all one vendor as the parent, and arena forbids a same-vendor judge.
- **Grafts:**
  - From C2: **panes and terminals never move in the DOM.** `<unlab-pane-area>` renders every pane keyed by machine and places visible ones with CSS grid; parked panes, inactive tabs and the lab body under the Wire and Add-machines views are `hidden`, never unmounted. This replaces C3's garage. The prototype already proves hide + `setRenderingPaused` + `fit()` on show.
  - From C2: the store's `until(pred, signal)`; notification scheduling that falls back from `requestAnimationFrame` to a `MessageChannel` turn while `document.hidden`, so agent calls in a background tab never hang.
  - From C1: **Vitest browser mode** (Playwright provider, real Chromium) for component tests, instead of a hand-built fixture page; a unit test that checks the handoff's contrast claims from `tokens.css`.
  - From C1 and C3: a button that runs a dangerous verb opens the bar already confirming (`confirmInBar`). One human confirmation surface.
- **Rejected:**
  - C1's runtime-owned allocation (two owners of "lowest free port").
  - C2's reconciler (indirect; effects-as-data gives the same idempotence with a traceable order).
  - C3's garage (unproven; not needed once panes never move).
  - `node --test` as the unit runner, and oxlint/oxfmt: Vitest and Biome are already installed and verified in commit `bebcb6c`. Layering is enforced by `scripts/check-imports.ts` instead of a lint plugin.

## Module map

```
src/
  main.ts           composition root: the only file importing every layer
  net/              pure packet code (page, worker, Node): frames, decode, filter, pcap
  model/            the pure lab: types, update (reducer), machines (identity, lifecycle,
                    allocation, plans), panes, tiling, selectors, store
  capture/          CaptureLog: ring, match index, ARP no-reply, link rows; CaptureView for readers
  commands/         grammar/ (tokenize, slots, parse, complete, fix, format), define.ts,
                    approval.ts, verbs/*.ts, registry (index.ts), bar model
  agent/            WebMCP detection, tool table derived from the registry, policies, approvals
  runtime/          engine (effect executor), vm (one worker per boot attempt), switch,
                    shell-tracker (OSC 133), screens (WTerm per session), theme,
                    nic, image, guest, protocol, vm-worker
  ui/               base/ (UnlabElement, Select controller, context), styles/, one folder per element
```

Import rules (enforced by `scripts/check-imports.ts` in `npm run check`):

| Layer | May import |
| --- | --- |
| net | nothing in src |
| model | net |
| capture | net, model |
| commands | net, model |
| runtime | net, model, capture, commands (types) |
| agent | model, capture (types), commands |
| ui | net, model, commands, capture (types), `services.ts` types. Never runtime or agent internals |
| main.ts | everything |

Cross-directory imports go through each directory's `index.ts`.

## Core contracts

- **State, events, effects, plans:** `src/model/types.ts`, adapted from `candidates/candidate-3/sketch/model.ts`. `update(state, event) → { state, effects }` is the only state change. Each producer gets its own narrowed dispatch (`dispatchRuntime`, `dispatchCommand`, `dispatchUi`, `dispatchAgent`). Time enters only through `tick` and stamped events.
- **Identity is arithmetic.** `node<n>` ↔ `10.88.0.(10+n)` ↔ `labMac(10+n)`. Names are ids and never reused.
- **Lifecycle** is the discriminated union in `types.ts`; failed holds no port; removing holds its port until gone; every runtime event carries `attempt`.
- **Allocation is derived, never stored:** taken ports, free hues.
- **Commands** per candidate 3 `sketch/commands.ts`: grammar slots → derived signature, parse, complete, format, fix, tool schema. `plan` is pure; `describe` gives the preview; `run` re-plans, executes, logs. Danger verbs need an `Approval`. Agent tools build a bar line and use the same parser.
- **Capture** per candidate 3 `sketch/capture.ts`: ring (10 000 entries), incremental match index, predicate over raw bytes, ARP no-reply sweep on tick, link rows written by the engine with their cause, at most one notification per animation frame.
- **Terminals:** `runtime/screens.ts` owns one `Screen` per session (WTerm + GhosttyCore, OSC 133 tracker, marks). `<unlab-terminal session>` is a socket the screen mounts into once. The screen buffers bytes until it mounts.

## Decided defaults for the handoff's open questions

Each is a reversible default, reported to the owner:

| Question | Default |
| --- | --- |
| Machine and port limit | 8 (one per hue and port) |
| Boot timeout | 120 s from spawn, reason `No prompt after 120 s.` |
| exec into a busy session | Detect via OSC 133 and refuse per target with a sentence |
| Exit codes | OSC 133 `D;$?` from the guest prompt; sentinel fallback; `exit ?` if neither |
| Open shortcut off macOS | Ctrl+/ |
| Tool names | underscores |
| Capture buffer | 10 000 entries; clear keeps counters |
| Persistence | none in v1 |
| Shells | no limit, no close button (a shell ends when its process exits) |
| Spawn options | images from the manifest; no CPU choice |
| Uplink | `lab only`, as in the prototype |
| Agent indicator after 5 min idle | `agent idle` |

## Quality gates

- `npm run check`: `tsc` (TS 7), `biome check`, `scripts/check-imports.ts`, `vitest run --project unit`, `vite build`.
- `npm run test:components`: Vitest browser mode, Chromium, each element in each state the handoff lists, axe.
- `npm run test:integration`: real kernels in Node.
- `npm run test:e2e`: Playwright against `vite preview` with real kernels and a fake `document.modelContext`.
- Unit tests use `fast-check` for pane properties and the grammar round trip `parse(format(a)) ≡ a`.

## Build order

The handoff's ten steps, each ending in a named check. Steps 1 and 2 are the foundation and land together, because the new shell needs the store to render anything.

1. Tokens, styles, fonts, `<unlab-app>` with six regions. Check: e2e region geometry; contrast unit test.
2. Model, store, net, switch reshape, capture log, commands core with `spawn`, `rm`, `link`, `focus`, `boot`, runtime engine. Check: model unit suite; capture oracle and push-cost tests; kernel integration test on the reshaped switch; e2e spawn → ready → link down → rm.
3. Rail and details in four lifecycle states. Check: component tests per state; e2e timeout → failed → boot again.
4. Panes: tiling, focus, parking, tabs, `sh`. Check: fast-check pane properties; e2e park, maximise, restore, scrollback kept.
5. Dock: faceplate and capture rows. Check: e2e cut → event row → flood annotation.
6. Command bar. Check: bar model replays artboard frames; e2e typo → fix → run.
7. `exec` with line marks. Check: tracker unit tests; e2e `exec all -- false` shows `exit 1` with grey rules.
8. Wire view. Check: filter and pcap unit tests; e2e flushed MAC row.
9. WebMCP and agent panel. Check: e2e with a fake modelContext (ask, deny, abort, off, pause).
10. Empty lab and Add machines. Check: e2e first run; form preview equals bar preview.
