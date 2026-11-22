# Grounding: unlab front-end rewrite

## Goal

Turn the working prototype in this repo into the production unlab.dev app specified by the designer's handoff at `/home/greg/Downloads/unlab-design/HANDOFF.md` (read it in full; it is the spec). Artboards are in `/home/greg/Downloads/unlab-design/artboards/*.dc.html` (inline-styled HTML, reference only). Rendered PNGs of the main ones are in `/tmp/claude-1000/-home-greg-src-unlab/5b2f2894-2274-44fc-8557-13146a335a83/scratchpad/boards/`. The owner wants production-ready, well-tested, maintainable front-end code using industry best practice. All UI code may be rewritten.

## What exists and works (keep, adapt at the edges)

The runtime layer is solid and has an integration test that boots two real kernels in Node and pings across the switch (`test/lab.test.ts`, passes in ~8 s).

- `src/lab/frames.ts`: pure Ethernet/ARP/IPv4 parsing, `Subnet`, `labMac(n)`, `classify()` (lab vs uplink).
- `src/lab/switch.ts`: `LabSwitch`, a transport-agnostic learning L2 switch. Ports by string id, `setLink(id, up)` flushes MACs learned on that port, `onTap(fn)` emits a `TapEvent { seq, t, fromPort, fromName, toPorts, flooded, frame }` per frame (synchronous, main thread), per-port counters, `macTable()`. It deletes flushed entries (spec wants them kept, struck through, until relearned). Ports have no numbers (spec: 8 numbered ports, lowest free at spawn, kept while cut).
- `src/lab/decode.ts`: one-line tcpdump-ish decode per frame.
- `src/lab/nic.ts`, `src/lab/image.ts`, `src/lab/guest.ts`: the NIC, shared image fetch, guest setup script.
- `src/lab/protocol.ts`: `ToVm` / `FromVm` message unions between page and worker.
- `src/vm-worker.ts`: one kernel per Web Worker. Boots with `createKernel`, posts `stage`, `booted`, `ready`, `console` bytes, `frame`, `exec-result`, `pty-ready/output/exit`, `error {fatal}`, `exited`. Supports `exec` (side channel: `vm.exec` returns exitCode/stdout/stderr without touching the console), `pty-open` (extra shells), `reconfigure` (hostname, /etc/hosts).
- `src/lab/machine.ts`: `Machine` (owns the worker, a switch port, sessions) and `Session` (scrollback buffer, `onData`, `write`, `resize`). Mutable classes with an `onChange()` callback.
- `src/lab/lab.ts`: `Lab` (machine list, name/address allocation, /etc/hosts sync across guests).

## What gets replaced

`src/main.ts` (module globals, imperative DOM, a `render()` that rebuilds lists), `src/ui/*` (sidebar, wire, topology, workspace HTML string, terminal pane), `src/style.css`. No store, no command layer, no unit tests, no lint, no e2e.

## Platform facts that constrain the design

- Vite 8 (rolldown/oxc), TypeScript 7.0 (native Go compiler; tooling that needs the JS TS API, e.g. typescript-eslint, may not work), Node 24, ES modules, `verbatimModuleSyntax`, `allowImportingTsExtensions`. Avoid TS decorators unless you are sure the toolchain transforms them; `static properties` works everywhere.
- Already decided by the owner (HANDOFF "Already decided"): vanilla TypeScript and custom elements; Catppuccin Mocha; one typeface; `exec` output typed into each console and marked, with a summary in the bar. A thin custom-element library (Lit) is compatible with "custom elements" and is a legitimate choice; hand-rolled is too. Justify whichever you pick.
- Terminal renderer: `@wterm/dom` `WTerm` over `@wterm/ghostty` `GhosttyCore` (WASM, compiled once, one core per terminal). DOM renderer that needs `@wterm/dom/css` (a global stylesheet), so the terminal element must live in light DOM or adopt that sheet. `WTerm` options include `onData`, `onResize`, `renderingPaused`, `autoResize`, `onShellIntegration(state: { phase: 'prompt'|'input'|'running'|'complete'|'unknown', exitCode: number|null })` (OSC 133), `setThemeColors`, `scrollToPrompt`, `readText()`, and a built-in `webmcp` option (registers the terminal itself as a WebMCP tool; we likely do not want that, the spec defines its own tools). `TerminalCore` exposes tracked positions (`TrackedTerminalPosition`) and scrollback counts, which is what a row-range gutter mark (`mark(fromRow, toRow, source)`) would anchor to.
- The switch tap fires synchronously per frame on the main thread. A ping storm or TCP transfer is hundreds to thousands of frames per second. Capture state must not cost O(buffer) per frame per subscriber.
- Workers: a kernel blocks its thread in `Atomics.wait`; termination is `stop` then `worker.terminate()` after 250 ms.
- WebMCP: `document.modelContext.registerTool(tool, { signal })` (older drafts `navigator.modelContext`; detect both). Tool = `{ name, description, inputSchema, annotations?, execute(input, { signal }) }`. No caller identity. Not present in most browsers; must degrade to nothing.
- Testing available: Node 24, Playwright's Chromium in `~/.cache/ms-playwright/chromium-1234`, system `chromium`. Real kernels boot in ~1-4 s in Chromium, so e2e against the real runtime is feasible.

## The spec's architectural demands (from HANDOFF "Components")

- One store holding machines, sessions, pane order and parking, ports and links, capture buffer, MAC table, command log, agent state. Elements subscribe and render; they never change state directly.
- One command registry: each verb has `parse`, `complete`, `validate`, `preview`, `run(args, { source, signal })`. A button, a bar line and a WebMCP tool all end in the same `run`, differing only in `source` ('bar' | 'button' | 'agent'). Agent tools validate with the command's validator and return its error sentences. `danger` drives bar confirmation and default agent policy.
- Machine lifecycle state machine: booting → ready | failed; failed → booting (boot again, same name/hue/image/mem, lowest free port); ready|failed → removing → gone. Only ready accepts commands. Hues: first of 8 not in use. Names `node<n>` monotonic, never reused. Ports 1-8, lowest free, kept while cut; `--no-net` = no port.
- Panes: one per machine, sessions as tabs (`console` permanent, `sh1..` never reused), tiling by capacity (cols = floor(width/400) max 3, rows max 2), focus-age-based auto-parking, user parking, maximise/restore exact layout, focus never moves panes.
- Line marks: lines injected by bar or agent get a gutter rule over a row range.
- Capture: rows with time, proto, route (names in hues), len, info, annotations (`flooded to port 2`, `unknown destination, flooded`, `no reply` after 1 s unanswered ARP), link event rows, filter grammar (space = and, `or`, proto/name/ip/mac/`port:3`), pause/clear/save .pcap, follow-tail.
- Command bar: combobox panel, grammar `verb targets args --opts`, `--` passthrough, completion by argument position, preview text shared with agent approvals, errors with caret token index and a one-edit `fix`, rm confirmation, history with source, Cmd-K / Ctrl+/ global shortcut, 1-8 quick focus.
- WebMCP: 7 tools with policies run / ask me / off, pending approvals as promises, pause tools, agent active until 5 min idle.
- Views: lab, wire, spawn (replace body), agent panel (460px column), empty lab. Status line derived from state. Accessibility: combobox, tablist, radio groups, one polite live region for announcements, focus ring, focus return.
