# unlab front end: candidate 1

**Shape in one line:** an event-sourced pure core (`domain/`), one effectful facade for the physical lab (`runtime/`), a capture ring that reaches state once per animation frame (`wire/`), commands as declared grammars that can only run through a validated `Prepared` (`commands/`), terminals that live as long as their session rather than their pane (`terminal/`), and Lit elements in light DOM that can read state and call three verbs (`ui/`).

Sketch files, all type-checked together with the repo's `tsc` 7 (`tsconfig.json` beside them):

- `sketch-domain.ts`: ids, `State`, the `Event` union, reducer, store, pane functions, selectors.
- `sketch-runtime-wire.ts`: reshaped `LabSwitch`, `LabRuntime`, `CaptureLog`, filter.
- `sketch-commands.ts`: `Command`, param grammar, `Prepared`, `spawn` / `link` / `rm` / `exec`, bar model.
- `sketch-shell.ts`: `Terminals`, WebMCP gate, `App` context, terminal mount, `createApp`, and compile-checked call sites.

## Problem

The prototype's runtime is sound (real kernels, a learning switch, an integration test) but its page is module globals and a `render()` that rebuilds lists. The handoff asks for one store, one command registry reached identically by a button, a bar line and a WebMCP tool, a four-state machine lifecycle, tiling with parking, a capture with commentary, and line marks in terminals. Four things make the shape non-obvious:

1. **Two rates.** Lifecycle, links, panes and commands change tens of times a second at most. The switch tap fires synchronously per frame, thousands a second under a TCP transfer, and terminal bytes are faster still. A store that notifies per event is right for the first kind and ruinous for the second.
2. **Facts with two possible owners.** Port numbers, names, link state and the MAC table are physical facts the switch already half-owns; hue, pane order and focus are presentation. If state and runtime both decide "lowest free port", they will disagree.
3. **Terminal state outlives the pane.** A parked pane keeps collecting output, and a line mark is anchored to a position inside one terminal core. If the terminal is created and destroyed with its element (as the prototype does), parking loses marks and `shell_read` has nothing to read.
4. **An approval can wait minutes.** The preview a person approves must describe exactly what runs, and the lab may have changed by the time they answer.

Constraints honoured: `LabSwitch` stays transport-agnostic and Node-testable; the worker protocol (`protocol.ts`, `vm-worker.ts`) is unchanged except one PS1 line in `guest.ts`; `@wterm/dom` needs its stylesheet in the terminal's tree and calls `document.getSelection()`; TypeScript 7 has no JS compiler API, so nothing in the toolchain may need one; no decorators.

## Usage (caller's view)

Everything the UI can do goes through `App` (`ui/context.ts`). An element author learns three verbs and one read.

```ts
// Read: a slice, re-rendered when that slice changes. (ui/machine-row.ts)
class MachineRow extends UnlabElement {
  static properties = { name: { type: String } };
  declare name: MachineName;
  #m = new Select(this, (s) => s.machines[this.name]);
  #focused = new Select(this, (s) => s.panes.focused === this.name);

  render() {
    const m = this.#m.value;
    if (!m) return nothing;
    return html`<button class="row" aria-current=${this.#focused.value}
        ?disabled=${m.phase.is === 'removing'}
        @click=${() => this.app.dispatch({ type: 'panes/focused', name: m.name })}>
      <span class="bar hue-${m.hue}" data-phase=${m.phase.is}></span>
      <span class="name">${m.name}</span> <span class="word">${linkWord(m)}</span>
    </button>`;
  }
}

// Verb 1, `act`: a button is a command with source 'button'. (ui/machine-details.ts)
html`<button class="btn" @click=${() => app.act('link', { state: m.cut ? 'up' : 'down', machines: names(m) })}>
       ${m.cut ? 'reconnect' : 'cut cable'}</button>
     <button class="btn danger" @click=${() => app.act('rm', { machines: names(m) })}>remove</button>`
// `rm` is dangerous, so `act` opens the bar on `rm node3`, already confirming. One confirm UI for humans.

// Verb 2, `dispatch`: state-only intents. Typed to UiEvent, so this does not compile:
app.dispatch({ type: 'machine/ready', name, bootMs: 1 });   // error: not a UiEvent

// Verb 3, `agent`: the approval buttons.
html`<unlab-confirm .title=${`${call.n} · waiting for you`} .detail=${call.preview}
       .actionLabel=${call.action} @confirm=${() => app.agent.answer(call.n, true)}
       @cancel=${() => app.agent.answer(call.n, false)}></unlab-confirm>`
```

The bar on Enter, and the agent, use the same two calls:

```ts
const p = commands.prepareLine('link dwon node3', 'bar');
// → { message: 'link wants up or down here, not dwon.', token: 1, fix: 'link down node3' }

const p = commands.prepare('rm', { machines: { is: 'names', names: ['node3'] } }, 'agent');
// → Prepared { line: 'rm node3', danger: true, preview: 'remove node3 and its disk',
//              action: 'Remove node3', confirm: { title: 'Remove node3?', detail: '…' } }
const result = await commands.execute(p, signal);   // re-validates, logs with source, runs
```

A new verb is one file:

```ts
export const sh = (deps: Deps) => defineCommand({
  name: 'sh', about: 'Opens another shell on a machine',
  params: { machine: P.machines() },             // signature, parse, complete, format: derived
  validate: (a) => a.machine.names.length === 1 ? null : { message: 'sh wants one machine.' },
  preview: (a) => `open a new shell on ${a.machine.names[0]}`,
  action: (a) => `Open a shell on ${a.machine.names[0]}`,
  run: async (a) => ({ is: 'done', summary: '…', data: { session: deps.lab.openShell(a.machine.names[0]!) } }),
});
```

A test of lab behaviour needs no browser:

```ts
const s = labFrom(spawned('node1'), ready('node1'), spawned('node2'));   // replayed through reduce
expect(commands(s).prepareLine('exec all -- uptime', 'bar'))
  .toMatchObject({ preview: 'type `uptime` into 1 consoles' });           // node2 skipped: still booting
```

## Shape

### Module map

```
src/
  domain/     ids, State, Event, reduce, store, panes, select, announce, fixtures     imports: nothing
  wire/       frames, decode, capture (ring), filter, explain, pcap                    imports: domain
  runtime/    lab-runtime, machine-process, switch, nic, image, guest, protocol,
              vm-worker (moved from src/lab and src/vm-worker.ts)                      imports: domain, wire/frames
  commands/   grammar, define, verbs/*, index (Commands, Prepared), bar-model          imports: domain, wire
  terminal/   terminals (WTerm per session), marks, prompt tracker, theme              imports: domain, @wterm/*
  agent/      webmcp (detect, register), gate (policies, approvals), shape             imports: domain, commands
  ui/         context, select, focus, keys, elements/*, styles/{tokens,shared,*}.css   imports: domain, commands (types), wire (types), terminal (types), lit
  app.ts      createApp: the only file that imports every layer
  main.ts     createApp({ root, manifest, spawnWorker }) and nothing else
```

Rules, enforced by `oxlint` `no-restricted-imports` overrides per directory (config lists each layer once; the table above is generated from it in the README):

- `domain/` imports nothing. `ui/` never imports `runtime/`. Only `app.ts` and `test/kernel/` import `runtime/`.
- Each layer exports through its `index.ts`; deep imports across layers (`../runtime/switch.ts` from `commands/`) are lint errors, so internals are unreachable.
- `lit` is importable only under `ui/`; `@wterm/*` only under `terminal/`.

### State and the store

`State` (full type in `sketch-domain.ts`) is immutable plain data: `lab`, `machines` (record by name), `rail`, `sessions`, `panes`, `net { capture, mac, totals, frames }`, `log`, `agent`, `ui`. Decisions that carry weight:

- **The machine's name is its id.** The spec makes names monotonic, never reused and not renamable. `MachineName` and `SessionId` (`node2:sh1`) are branded strings, minted by the runtime and parsed from user text in exactly one function (`pinTargets`). No id-to-name map exists to drift.
- **Lifecycle is a discriminated union** (`Phase`): `since` and `stage` exist only while booting, `reason` only when failed. `ReadyMachine` narrows it for the verbs that need a ready machine. `nextPhase(from, event)` is the handoff's state diagram as one table, tested as a table.
- **One writer per fact.** The runtime owns physical facts (name, address, MAC, port, link, lifecycle, session ids) and reports them as `RuntimeEvent`s. The reducer owns presentation facts (hue, pane order, parking, focus, tabs) and assigns the hue at `machine/spawned`: first of eight not in use, freed at `machine/gone`, kept across Boot again because the record persists. Nothing is decided twice.
- **Events are the only write path** and come in families by writer: `RuntimeEvent`, `WireEvent`, `TerminalEvent`, `CommandEvent`, `AgentEvent`, `UiEvent`. Each writer is handed a dispatch typed to its own family, so the split is checked by the compiler, not by convention.
- **Every transition is idempotent.** `reduce` returns the same object for an event that does not apply (a `ready` from a worker whose machine was removed). A late or duplicated worker message cannot corrupt the lab.
- **Derived, never stored:** port views, link words, status segments, agent wording, free ports, tiling. All in `select.ts`, all table tests.

The store is forty lines: `dispatch` reduces synchronously (a command reads its own writes on the next line), then calls each `select` listener whose selected value changed by `Object.is`. Because the reducer shares structure, `s => s.machines[name]` is a pointer compare; with about forty subscriptions and tens of events a second this needs no scheduler, and Lit already coalesces the resulting `requestUpdate`s into one render per microtask. A dispatch made inside a listener is queued, never nested.

I chose a reducer over signals because the lab's hard requirements are transition rules (lifecycle, parking, maximise-restore) and those are easiest to get right, and to prove right, as `(state, event) → state`. Signals would give finer-grained updates the app does not need and would spread the rules across setters.

### How thousands of frames a second enter the store

They do not, individually. `LabRuntime.onWire` feeds `CaptureLog.push` (in `wire/`), which per frame does fixed-offset header reads, one ring-slot write, and one `Map` operation if the frame is ARP. No decode string, no filter, no listener, no allocation that grows with the buffer.

At most once per animation frame the log calls `onTick`, which dispatches a single `wire/tick { first, head, rev, totals, mac, frames }`. That event is O(ports). `state.net.capture` is therefore an **index into the ring**, not the ring:

- `<unlab-capture>` selects `s.net.capture.head` and `rev`, then calls `view.sync()` (extends its filtered match index over the new rows only) and renders a window: the last eight matches in the dock, a fixed-row-height virtual window in Wire. Per frame per subscriber: zero. Per tick per subscriber: O(new rows) plus O(rows on screen).
- The one-line decode is computed on first read of a row, so only rows that reach the screen pay for it.
- Changing the filter rebuilds one view's index once: O(buffer), user-initiated.
- `no reply`: ARP requests queue FIFO with a deadline (expiry is O(1)); a matching reply dequeues; an expired request's row gets the note in place and `rev` bumps, which is what tells views to re-read rows they already hold. A timer covers the case where no further frame arrives.
- Pause is `paused()` read from state on the hot path; a paused push drops the row but still ticks, so the footer counters keep running as the spec requires. Clear empties the ring and bumps `rev`.

Terminal bytes follow the same principle more strictly: they never touch the store. `SessionPipe.attach` hands bytes straight to that session's terminal core.

### The runtime boundary

| Prototype | Becomes | Why |
| --- | --- | --- |
| `LabSwitch` | **Kept and reshaped** (`runtime/switch.ts`) | Ports are numbered 1 to 8 and allocated here (`lowestFree()`), so "port 3" means one thing everywhere. `setLink(port, false)` marks entries `flushed` instead of deleting them; a flushed entry is ignored for forwarding, cleared when the port relearns the MAC, and deleted on `detach`. The tap item gains `flood: 'no' \| 'group' \| 'unknown'`, which is what distinguishes `flooded to port 2` from `unknown destination, flooded to port 2`. Link changes are emitted on the same ordered feed as frames, with their `cause`, so capture's `port 3 link down` row cannot land out of order. Still no DOM, still runs in Node. |
| `Machine` | **`MachineProcess`, private to `runtime/`** | Owns one worker and the protocol. Loses all display state (`status`, `state`, `bootMs`), which now lives in `State`. The worker is injected as `WorkerLike`, so the same class runs on `worker_threads` in the kernel test and on a scripted fake in unit tests. |
| `Session` | **`SessionPipe`**: write, resize, attach | Scrollback, marks and prompt state move to `terminal/`, where the terminal core already holds them. The pipe buffers only until its one subscriber attaches. |
| `Lab` | **`LabRuntime`**, the facade | Eight methods: `spawn`, `bootAgain`, `remove`, `setLink`, `openShell`, `closeSession`, `session`, `execQuiet`. Hides workers, image fetch-once, address and MAC assignment, the name counter, port allocation, the boot timeout, `/etc/hosts` sync, stop-then-terminate, session numbering. |

Specifics:

- **Names.** A counter in `LabRuntime` that only increments. `node<n>` gets `10.88.0.(10+n)` and `labMac(10+n)`, as today.
- **Ports.** `spawn` with `net: true` attaches each machine to `switch.lowestFree()` immediately, link down, so the port is reserved while booting (dotted cable). `machine/ready` raises the link. A cut keeps the port. `machine/failed` detaches it (cable withdrawn). `--no-net` never attaches; `link up` on it attaches to the lowest free port and emits `link/plugged`.
- **Lifecycle.** booting → ready on the worker's `ready`; → failed on a fatal `error`, a worker `error` event, an image fetch rejection, an unexpected `exited` (someone ran `poweroff`), or the boot timeout (default 30 s, injectable clock). The reason is the runtime's sentence, verbatim. `bootAgain` is a no-op unless failed; it starts a new worker under the same name and console session, so the old log stays above a separator. `remove` emits `machine/removing`, drops the link first, sends `stop`, terminates after 250 ms, detaches, emits `machine/gone`; a second call returns the same promise.
- **Commands never import this.** They see `LabPort` (five methods, declared in `commands/`), which `LabRuntime` satisfies structurally. Commands validate against `State`; `LabError` is the backstop for a race, never the message a user reads.
- **The kernel test moves onto the facade.** `test/kernel/lab.test.ts` builds a `LabRuntime` with a `worker_threads` adapter and asserts on events and frames, replacing the hand-rolled boot dance it has today. The production lifecycle is then what the kernel test exercises.

### Commands

The handoff's `Command<Args>` contract is kept: `name`, `signature`, `danger`, `parse`, `complete`, `validate`, `preview`, `run(args, { source, signal })`. Four things are added, each to remove a copy that would otherwise be synced by hand.

1. **Params are declared; grammar is derived.** `defineCommand({ params: { count: P.int(...), image: P.image(), mem: P.flag('--mem', ...) } })` yields `signature`, `parse`, `complete`, `format` and the WebMCP input schema. The error `link wants up or down here, not dwon.` with its token index and one-edit `fix` comes from the param that rejected the token, so every verb gets the handoff's error style without writing it. A property test asserts `parse(tokenise(format(args))) ≡ args` for every verb.
2. **`Prepared` is the only thing that runs.** `prepareLine` (bar) and `prepare` (button, agent) both do pin → validate → preview and return a branded `Prepared` or a `LineError`. `execute(prepared)` is the single entry to `run`. Nothing can run unvalidated, and the preview in a confirm or approval block is the preview of the object that will run. `execute` validates again first, because an approval may have waited; it never rejects, turning a throw into the same error block.
3. **Targets are pinned.** `parse` yields targets as written (`all`, `node*`); `pin` resolves them once to names plus a `skipped` list (`skipped node4: still booting`). The preview names the machines; `run` touches those machines. This is the one place my `Command` differs from the handoff's shape (`Command<Args, Raw>`).
4. **The tool is a face of the command.** `tool: { name: 'machines_remove', defaultPolicy: 'ask', annotations }` sits beside the verb. The WebMCP adapter iterates `commands.verbs`; there is no second table. `shell_read` and `capture_read` are commands with `bar: false`, so reads go through the same validation, log and policy path.

How the three surfaces converge:

| Surface | Entry | Confirmation | Logged as |
| --- | --- | --- | --- |
| Bar | `prepareLine(line, 'bar')` on Enter | `danger` → the bar's `confirming` state shows `<unlab-confirm>` from `prepared.confirm` | `bar` |
| Button | `app.act(verb, raw)` → `prepare(..., 'button')` | `danger` or error → opens the bar seeded with `prepared.line`, already confirming | `button` |
| Agent | tool `execute` → `prepare(..., 'agent')` | policy `ask` → pending call showing `prepared.preview` and `prepared.action` | `agent` |

The log is `state.log`, written by `execute` alone (`command/started`, `command/finished`), each entry carrying `prepared.line` in bar grammar whatever the source. `recent` is the last three entries; the blue rule is `source === 'agent'`.

**The bar** is split in two pure pieces and one thin element. `commands.analyse(line, caret)` returns a `BarModel` (tokens, signature with the active argument, suggestions, hint, `ready: Prepared | null`, held-back `error`). `barStep(state, key, model, history)` is the panel's state machine (`editing`, `confirming`, `running`, `result`) returning the next state and an effect; the whole keyboard map is a table test. `<unlab-command-bar>` renders the model with combobox roles and performs effects.

**`exec`** types the line into each target's active session through `ConsolePort.inject`, in parallel, and returns per-machine exit code, last line and output. It refuses a session whose `activity` is `busy` (this answers the handoff's "exec into a busy session" question with "detect and refuse"). Exit codes come from OSC 133 (see Terminals), not from the `vm.exec` side channel, because the owner decided the output must be typed into the console.

### Panes

Pure functions over `Panes` in `domain/panes.ts`; the reducer is their only caller.

- `capacityFor(width, height)`: `cols = clamp(floor(width / 400), 1, 3)`, `rows = height >= 400 ? 2 : 1`. `<unlab-pane-area>` observes its size and dispatches `panes/capacity` only when the result changes, so a resize that does not cross a threshold changes nothing.
- `settle(panes, keep?)` restores the invariants and is the only function that auto-parks or auto-returns: while visible exceeds capacity, park (as `auto`) the visible pane touched longest ago, never `keep`; while there is room, bring back `auto` panes, most recently touched first. `user` parks are never touched. `settle ∘ settle = settle` is a property test.
- `addPane`, `removePane`, `parkPane` (user), `unparkPane`, `promotePane`, `focusPane`, `toggleMaximise` each make their one change and end in `settle`. `focusPane` stamps `touched` and sets `focused`; on a parked pane it unparks with `keep`. It never changes `order` or the parking of a visible pane, which is "focusing never moves a pane" as a property test.
- `toggleMaximise` stores the exact `parked` record in `maximised.restore`, parks the rest as `auto`, and treats capacity as one. Toggling off writes `restore` back, then settles (in case the window shrank meanwhile).
- `tiling(visibleCount, cols)` returns CSS grid data for the six layouts in the table, including the 3:2 main-and-stack. The element applies it and does nothing else.

### Terminals and line marks

**One terminal per session, for the session's life** (`terminal/terminals.ts`). `Terminals` subscribes to the store: `session/opened` creates a host (a `<div>`, a `WTerm` on a `GhosttyCore`, the WASM compiled once), `session/closed` destroys it. A host is either shown in a `<unlab-terminal>` or waiting in an off-screen lot at its last size with painting paused. Parking, tab switches, maximise and the Wire view only move the node (`Element.moveBefore` where present), so scrollback, selection and marks survive and no parked guest receives a resize to zero.

`<unlab-terminal session focused>` owns no terminal state. It asks `app.terminals.host(session).show(slot)` on connect and `hide()` on disconnect, and draws the gutter.

**Marks** belong to the host because the host does the injecting. `inject(session, line, source)`:

1. tracks the cursor position (`core.trackPosition`) and writes `line + '\r'`;
2. waits for the next prompt, signalled by OSC 133: `guest.ts` gains one line setting `PS1` to emit `133;D;$?` then `133;A`, so the exit code arrives invisibly with every prompt and `WTerm.onShellIntegration` delivers it;
3. tracks the row above the new prompt as the end, and resolves with the exit code, the last line and the range's text, read from the grid.

A mark is `{ start, end, source }` in tracked positions, so it follows scrolling and reflow and vanishes when pruned. The element draws each as a 2px rule in the 14px gutter at `fromRow * rowHeight - scrollTop`, `--text-3` for bar and button, `--agent` for the agent. This replaces the handoff's suggested `mark(fromRow, toRow, source)` method: callers do not know rows, and should not.

The same tracker yields `session/activity` (`prompt` after 133;A, `busy` once a line is submitted, `unknown` for a shell that never emitted OSC 133). For an `unknown` session `inject` appends `; printf '\033]133;D;%s\007' $?`, which is the handoff's sentinel made invisible on output.

wterm's own `webmcp` option stays off; `announceOutput` is on for the focused terminal (the renderer's screen-reader mode).

### Component layer

**Lit 3, no decorators, light DOM, one stylesheet.**

- **Lit, not hand-rolled.** The UI is mostly keyed lists whose rows change attributes (rail rows, tabs, ports, suggestions, capture rows, call log). Hand-rolled elements need either string templates (the prototype's problem) or a private diffing helper, which is a worse lit-html that the next contributor must learn. Lit is about 6 kB, is a custom-element base class and nothing more, needs no compiler step (`html` is a tagged template; `static properties` plus `declare` fields avoid decorators and the class-field shadowing trap, which Lit's dev build reports), and brings `repeat` and reactive controllers. "Vanilla TypeScript and custom elements" holds: every element is a standard custom element usable from plain HTML.
- **Light DOM, deliberately against the handoff's "adopted by each element".** Three reasons, each sufficient: wterm's stylesheet is document-scoped and it calls `document.getSelection()`, which does not see into shadow roots, so terminals must be in the document tree and so must every ancestor; the combobox's `aria-activedescendant` and `aria-controls`, and `<label for>`, are IDREFs that do not cross shadow boundaries; and "dividers are gaps" means a parent's grid styles its children's surfaces. Encapsulation protects a component library from its host page; this is one app that owns every rule. Scoping comes from `@scope (unlab-pane) { … }` blocks and cascade layers.
- **Styles.** `ui/styles/tokens.css` is the handoff's `:root` block verbatim. `shared.css` holds `.btn`, `.field`, `.select`, `.row` and the one focus ring. Each element has `elements/<name>.css` wrapped in `@scope`. Layers: `@layer tokens, base, shared, elements, terminal;` with `@wterm/dom/css` imported into `terminal`. A unit test parses `tokens.css` and the terminal theme and checks the contrast ratios the handoff claims.
- **Context.** `<unlab-app>` answers a `context-request` event with the `App`. `UnlabElement` (the shared base) resolves it once. Component tests wrap an element in a provider holding a fake `App` over a fixture state.
- **Keyboard.** `ui/keys.ts` installs one capture-phase listener for the open shortcut, ahead of any terminal. `ui/focus.ts` is the only caller of `.focus()` on terminals and the bar: keyboard ownership is derived from `ui.bar.open` and `panes.focused`, so closing the bar returns focus without anyone saving an element.
- **Announcements.** `announce(event, state)` in `domain/` produces the sentence; `<unlab-app>` renders `ui.announcement` into the one polite live region. The capture list is not live.
- **Elements** are the handoff's sixteen, with `<unlab-parked-strip>` split from `<unlab-pane-area>`. Leaf elements that the Components sheet draws in isolation (`<unlab-port>`, `<unlab-confirm>`, `<unlab-machine-row>`) take properties only and never touch the store, so the gallery and tests can render every state from literals.

### WebMCP

`agent/webmcp.ts` detects `document.modelContext` then `navigator.modelContext` and parses nothing else from the platform; absent, the gate is inert and the indicator reads as the spec says. `agent/gate.ts` registers one tool per verb with a `tool` face, each with its own `AbortController` (policy `off` and "pause tools" abort it). Tool `execute` is: parse input with the derived `Shape` → `prepare(..., 'agent')` → dispatch `agent/called` → if policy is `ask`, await `answer()` (agent abort settles the call as `aborted` and its block disappears; Deny returns `Denied by the user.`) → `commands.execute` → return `tool.output(result)`. Pending answers are a private `Map<number, resolver>`; everything the panel shows is in `state.agent`. A five-minute timer reset on each call dispatches `agent/idled`.

### Testing and quality gates

| Layer | Tool | Runs in | What it proves |
| --- | --- | --- | --- |
| Unit | Vitest 4, project `unit` | Node | `reduce` and `nextPhase` tables; pane properties (`settle` idempotent, focus never moves, maximise restores exactly); every selector; grammar round-trip per verb; each verb's `validate` / `preview` sentences against fixture states; `barStep` against the keyboard map; `CaptureLog` with a manual clock (annotations, `no reply`, eviction, pause, **a push-cost test: 100 000 pushes with a full ring and three views stay under a budget and call no listener**); filter grammar; pcap bytes; `LabSwitch` (numbered ports, flushed retention); `LabRuntime` on a scripted `WorkerLike` (timeout, boot again, remove ordering). |
| Component | Vitest browser mode, Playwright provider, Chromium | Real browser | Each element in each state from the handoff's "States to cover" column, rendered from `labFrom(...)` fixtures behind a fake `App`: roles, accessible names, the state word, what a click dispatches or `act`s. No jsdom. |
| Kernel | `node --test test/kernel/` | Node, real kernels | The existing two-machine ping, now through `LabRuntime`; cut → flood → reconnect → relearn. |
| E2E | `@playwright/test` against `vite preview` of the built app | Chromium, real kernels | The acceptance paths below. A `document.modelContext` shim installed by `addInitScript` records registered tools so tests can call them as an agent would. |
| A11y and visual | `@axe-core/playwright`; `toHaveScreenshot` on `/gallery.html` | Chromium | A dev-only gallery page renders every element state from fixtures, mirroring the Components artboard. Axe runs on it and on each view. |
| Static | `tsc -p .` (TS 7); `oxlint --type-aware` (tsgolint, built on the native compiler, so no JS API); `oxfmt --check` | | Types, floating promises, exhaustive switches, the import rules above. |

Not used, because they need the TypeScript JS API or a simulated DOM: typescript-eslint, ts-jest, dependency-cruiser's TS mode, jsdom, happy-dom.

`npm run check` = `tsc` → `oxlint` → `oxfmt --check` → `vitest run` (unit and component) → `node --test test/kernel` → `vite build` → `playwright test`. `npm run check:fast` stops after Vitest, for the inner loop. CI runs `check`.

### Build order

Each step leaves the app working and ends in a named check that stays in `npm run check`.

| # | Handoff step | What lands | Verification |
| --- | --- | --- | --- |
| 0 | (before 1) | Tooling: Lit, Vitest projects, oxlint and oxfmt, Playwright. `src/lab` → `src/runtime` and `src/wire` by `git mv`. | `e2e/smoke.spec.ts` *two machines boot and ping* passes against the prototype UI; kernel test still green. |
| 1 | Tokens, shared stylesheet, shell regions | `tokens.css`, `shared.css`, `<unlab-app>` grid with six regions; the prototype's sidebar, terminals and wire mounted inside them. | `tokens.test.ts` *contrast ratios hold*; `e2e/shell.spec.ts` *six regions, exact heights, divider unbroken*. |
| 2 | Store and command registry | `domain/`, `LabRuntime` and reshaped `LabSwitch`, `commands/` with `spawn`, `rm`, `link`, `focus`; `app.act` behind the existing buttons. | Unit: *lifecycle table*, *hue and port allocation*, *grammar round-trip*. Kernel: *runtime lifecycle on real kernels*. E2E: *prototype buttons still work, log records `button`*. |
| 3 | Rail and details | `<unlab-machine-row>`, `<unlab-machine-details>`, boot timeout, Boot again. | Component: *row in four phases × three link words*. E2E `lifecycle.spec.ts`: *spawn → booting counter → ready; forced failure → Boot again → ready; rm → gone*. |
| 4 | Panes | `panes.ts`, `<unlab-pane-area>`, `<unlab-pane>`, `<unlab-parked-strip>`, `Terminals`, `<unlab-terminal>`. | Unit: *pane properties*. E2E `panes.spec.ts`: *six tilings by count; resize parks and returns; maximise restores; parked terminal keeps its scrollback*. |
| 5 | Dock | `CaptureLog`, `<unlab-switch>`, `<unlab-port>`, `<unlab-capture mode="dock">`. | Unit: *push cost budget*. E2E `dock.spec.ts`: *ping shows ARP then ICMP; port click cuts; link row names its cause; flood annotated*. |
| 6 | Command bar | `analyse`, `barStep`, `<unlab-command-bar>`, `<unlab-confirm>`, remaining verbs except `exec`. | Unit: *keyboard map table*, *error sentences and fixes*. E2E `bar.spec.ts`: *open shortcut from inside a terminal; complete; preview; error with carets; rm confirm; focus returns*. Axe on the open bar. |
| 7 | `exec` with marks | PS1 line in `guest.ts`, prompt tracker, `inject`, gutter rules, `exec` verb and result block. | E2E `exec.spec.ts`: *`exec all -- false; true` reports exit codes; grey rule spans the command and its output and survives scrolling and parking; busy session refused*. |
| 8 | Wire | `<unlab-capture mode="full">` (virtual list), `<unlab-mac-table>`, `<unlab-frame-detail>`, filter, pcap. | Unit: *filter grammar*, *pcap header and records*. E2E `wire.spec.ts`: *filter count; cut shows flushed entry struck through until relearned; saved pcap parses*. |
| 9 | WebMCP | `agent/`, `<unlab-agent-panel>`, the two read verbs. | E2E `agent.spec.ts` with the shim: *seven tools registered; `ask` waits and shows the bar's preview text verbatim; Deny returns the sentence; abort removes the block; `off` unregisters; blue rule*. |
| 10 | Empty lab and Add machines | `<unlab-spawn-form>` (builds a `spawn` line and shows it), empty view. | E2E `first-run.spec.ts`: *empty → form → two machines ready*; *not enough free ports offers `--no-net`*. Full `npm run check` and the gallery screenshot baseline. |

## Tradeoffs accepted

- We accept **the name as identity** in exchange for no id map anywhere. If renaming machines is ever wanted, `MachineName` splits into id and label and every record keyed by it migrates.
- We accept **a projection** (machine facts live in the runtime and again in `State`) in exchange for pure, fixture-testable validation and rendering. The events are the only sync, emitted synchronously, and the reducer is total over them.
- We accept **the capture ring outside the immutable state** in exchange for O(1) per frame. Rows are mutable in one way (`note`), signalled by `rev`. A reader who expects "everything in the store is immutable" will find one documented exception.
- We accept **light DOM and global CSS** in exchange for a working terminal, working ARIA references and simple tests. Style leaks are possible; `@scope` and one element per stylesheet are the discipline, and the screenshot gallery is the net.
- We accept **a terminal core per session, including parked and background tabs** (memory: one WASM grid plus 5 000 lines of scrollback each) in exchange for marks, scrollback and `shell_read` that survive parking. Eight machines with a few shells each is a few dozen cores.
- We accept **a small own schema helper** (`agent/shape.ts`, about sixty lines) instead of zod, because seven flat inputs are derived from params and WebMCP's accepted JSON Schema subset is still moving.
- We accept **diverging from the handoff in three named places**: light DOM, `Command<Args, Raw>` with pinned targets, and marks owned by the terminal host instead of a `mark(fromRow, toRow, source)` element method.
- We accept **a dependency (Lit)** in exchange for not maintaining a renderer. It is confined to `ui/` by lint.

## Alternatives considered

- **Signals as the store** (TC39 polyfill or Preact signals, one signal per slice, elements auto-track). Smaller surface for readers, and fine-grained updates for free. It lost because transition rules would live in setter methods spread over several objects, with no single total function to test against the lifecycle diagram and the parking rules, and because per-frame capture updates would still need the ring-and-tick design beside it. Interface depth is similar; provability is worse.
- **Runtime as the store**: keep `Lab` and `Machine` as mutable classes, add events, let elements read them directly. Shortest path from the prototype and no projection. It lost because every element would depend on worker-owning classes (untestable without workers), validation could not run against a fixture, and presentation facts (hue, parking) would be pushed into runtime objects or into a second store, which is split ownership.
- **Elm-style effects** (the reducer returns commands that an interpreter runs against workers). Pure to the edge. It lost on depth: the lifecycle's timers and worker handles would be re-expressed as effect descriptions plus an interpreter, a second representation of what `LabRuntime` already hides behind eight methods.
- **Shadow DOM with adopted sheets, terminal slotted from the document.** Matches the handoff's wording. It lost because the terminal would have to be slotted through three shadow roots (app, pane area, pane) to stay in the document tree, and the combobox would need its input and listbox hoisted for the same reason. Two exceptions to the rule is where a rule stops helping.
- **Terminal per pane element, replaying a byte scrollback on mount** (the prototype's model). Less memory. It lost because replay cannot restore marks (positions die with the core) and re-parses up to 256 kB on every unpark and tab switch.

## Open questions and risks

1. **Does busybox `ash` on the Alpine image expand `$?` inside `PS1`, and pass OSC sequences through `\[ \]`?** The exit-code path depends on it. If not, `inject` uses the sentinel form for every line (already the fallback), and the echoed command shows the suffix. Step 7 starts with this spike.
2. **Is `exec` refusing a busy session acceptable**, or should bar and agent lines go to a dedicated shell per machine? The design supports either by changing which session `exec` resolves.
3. **Does wterm keep parsing and keep its size while its element sits in an off-screen container?** `renderingPaused` suggests yes. If `autoResize` misbehaves there, the lot gets explicit dimensions per host. Step 4 starts with this spike.
4. **Mark geometry assumes `row * rowHeight - scrollTop`**, which holds if wterm's scrollback spacers preserve height (the renderer source suggests so). If not, marks position from the row elements' rects instead; the `MarkView` contract does not change.
5. **Does `oxfmt` format this codebase stably today?** If not, Biome's formatter is the drop-in (also free of the TS JS API); oxlint stays.
6. **Does the installed Chromium build (1234) match a Playwright release that Vitest 4's browser provider accepts?** If not, both point at the system `chromium` by `executablePath`.
7. **Should a button that removes a machine really route through the bar's confirm?** I chose one human confirmation surface. The alternative is an inline `<unlab-confirm>` in the details panel using the same `Prepared`.
8. **Boot timeout of 30 s, capture ring of 10 000 rows, clear keeps counters, shells unlimited with no close button, no persistence.** These are my defaults for the handoff's undecided items; `State` is plain serialisable data so persistence is a later subscriber, not a redesign.
9. **Maximum eight machines even with `--no-net`** (hues run out). Is that the intended reading?

## Next implementation step

Write `domain/state.ts`, `domain/events.ts` and `domain/reduce.ts` with the `nextPhase` table and its test, replaying the handoff's lifecycle diagram, because every other module's signatures depend on `State` and `Event` being right.
