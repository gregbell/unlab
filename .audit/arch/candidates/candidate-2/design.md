# unlab front end, candidate 2: reducer + lanes + reconciler

## Problem

We are rebuilding the front end of a working prototype as the production
unlab.dev app described in `HANDOFF.md`. The runtime works and has tests:
real kernels in Web Workers (`vm-worker.ts`), a learning L2 switch
(`switch.ts`) whose tap fires synchronously on the main thread for every
frame, a NIC, frame parsing and decoding. Around it sit two mutable classes,
`Machine` and `Lab`. They own identity, lifecycle and naming, and they push
changes out through an `onChange()` that `main.ts` handles by rebuilding the
DOM.

Four things make the shape non-obvious.

1. **Two data rates.** Lab facts change a few times a second: machines,
   links, panes, the log, the agent. Frames and terminal bytes arrive
   thousands of times a second. A store that treats both the same either
   re-renders per frame or does O(buffer) work per frame.
2. **Three surfaces, one effect.** Bar, button and agent must reach the same
   `run`. Some effects are long-lived and ordered. `rm` drops the link
   first, then stops the worker, then frees the port and the row. Boot
   again starts a fresh worker while late messages from the old one are
   still arriving.
3. **The spec puts rules in the domain, not the runtime.** Monotonic
   names, first free hue, lowest free port that is kept while cut, MAC
   entries kept struck through after a flush, park-by-focus-age. The
   current switch deletes flushed MAC entries and has no port numbers.
4. **Terminals are stateful DOM.** A WTerm plus GhosttyCore is expensive
   to rebuild, and moving it in the DOM disconnects it. Line marks must
   survive reflow, tab switches and parking.

Platform constraints: Vite 8, TypeScript 7 (the native compiler, so no tool
that needs the JS TS API), Node 24 type stripping, `verbatimModuleSyntax`,
no decorators, wterm's global stylesheet, and WebMCP feature-detected on
`document.modelContext` then `navigator.modelContext`.

## Usage (caller's view)

### The contributor's quickstart (the README section this design produces)

> **How unlab changes state.** Everything you see is a function of
> `store.state` (a `LabState`) plus two append-only lanes: the capture buffer
> and session byte logs. State changes only through `store.dispatch(event)`,
> which runs the pure `reduce`. Lanes are written only by the runtime.
>
> **How to add a verb.** Add one file under `src/commands/verbs/`, export
> `defineCommand<Args>({ … })`, and append it to `REGISTRY`. The bar parses,
> completes, previews and confirms it. The button helper `press()` runs it.
> If it has an `agent` binding it becomes a WebMCP tool with that policy.
> Nothing else needs listing.
>
> **How to make the kernels do something.** You don't, from a command.
> Dispatch the intent (`{type:'cable', …}`) and the reconciler makes the
> switch and workers match at the next flush. Only byte-level I/O and
> `execInSession` are called directly on `Runtime`.
>
> **How to show something.** Extend `View<Slice>`, write `select(state)` and
> `render(slice)`. The element re-renders when its slice changes, at most
> once per animation frame.

### Call site 1: a button in the details panel

```ts
// src/ui/elements/machine-details.ts
class MachineDetails extends View<DetailsSlice> {
  protected select = selectDetails;          // pure, unit-tested
  protected render(d: DetailsSlice) {
    return html`
      <button class="btn" @click=${() => press(link, { up: d.cut, machines: [d.name], skipped: [] }, this.env)}>
        ${d.cut ? 'reconnect' : 'cut cable'}</button>
      ${this.confirming
        ? confirmPart({ question: rm.confirm!(this.rmArgs, this.env.store.state),
                        action: rm.actionLabel(this.rmArgs),
                        onYes: () => press(rm, this.rmArgs, this.env), onNo: () => this.cancel() })
        : html`<button class="btn danger" @click=${() => this.askRemove()}>remove</button>`}`;
  }
}
```

### Call site 2: the agent path, end to end (`src/agent/tools.ts`)

```ts
execute: async (input, { signal }) => {
  env.store.dispatch({ type: 'agent-call', line: '(pending)', at: Date.now() });
  const args = binding.fromInput(input, env.store.state);
  if (isLineError(args)) return args.message;
  const bad = cmd.validate(args, env.store.state);
  if (bad) return `${bad.message} Nothing was changed.`;
  if (policyOf(binding.tool) === 'ask') {
    const id = env.store.state.agent.nextCall;
    env.store.dispatch({ type: 'agent-pending', call: {
      tool: binding.tool, line: cmd.format(args),
      preview: cmd.preview(args, env.store.state).will,      // the bar's exact words
      actionLabel: cmd.actionLabel(args) } });
    if (await approvals.wait(id, signal) === 'deny') return 'Denied by the user.';
  }
  const r = await invoke(cmd, args, { source: 'agent', signal, env });   // same as the bar
  return isLineError(r) ? r.message : r.data;
}
```

### Call site 3: tests read like the spec

```ts
// test/unit/lifecycle.test.ts — no DOM, no worker
let s = initialState({ images: ['alpine'], now: 0 });
s = reduce(s, { type: 'spawn', plan: planSpawn(s, 2, 'alpine', 256, true) as SpawnPlan, source: 'bar' });
s = reduce(s, { type: 'tick', now: BOOT_TIMEOUT_MS });
assert.equal(s.machines.get(N('node1'))!.life.phase, 'failed');
assert.equal(s.machines.get(N('node1'))!.net.port, null);          // port freed
s = reduce(s, { type: 'rt-ready', machine: N('node1'), attempt: 1, bootMs: 900 }); // arrives after the timeout
assert.equal(s.machines.get(N('node1'))!.life.phase, 'failed');    // failed ignores rt-ready
s = reduce(s, { type: 'boot-again', machine: N('node1'), source: 'button' });
s = reduce(s, { type: 'rt-ready', machine: N('node1'), attempt: 1, bootMs: 900 }); // old worker
assert.equal(s.machines.get(N('node1'))!.life.phase, 'booting');   // stale attempt dropped

// test/unit/commands.test.ts — property: every logged line is re-runnable
fc.assert(fc.property(arbSpawnArgs, (a) =>
  deepEqual(spawn.use(c => c.parse(tokenize(c.format(a)), s)), a)));
```

### Call site 4: the composition root (`src/main.ts`, the only file that sees every module)

```ts
const { store, writers } = createStore({ initial: initialState({ images, now: performance.now() }) });
const { runtime, names } = startReconciler(store, { lanes: writers, sw: new LabSwitch(), image, spawnWorker });
const env: Env = { store, runtime };
provide(env);
defineElements();                                   // customElements.define for every View
startAgent(env, detectModelContext(), tools(REGISTRY, env), policyOf(store));
document.body.append(document.createElement('unlab-app'));
```

## Shape

### Module map

```
src/
  main.ts            composition root (above); nothing else imports across all layers
  domain/            PURE. types.ts, identity.ts (planSpawn, hues, ports, names, ip/mac),
                     reduce.ts (+ lifecycle.ts, panes.ts helpers), targets.ts, selectors.ts
  store/             store.ts (dispatch/select/until/flush), capture.ts (ring, filter,
                     ArpWatch, pcap), sessions.ts (SessionLog ring + marks)
  runtime/           MOVED UNCHANGED: frames.ts decode.ts nic.ts image.ts guest.ts protocol.ts
                     vm-worker.ts. CHANGED: switch.ts (flushed entries, version, unknownUnicast).
                     NEW: driver.ts (was Machine), reconciler.ts (was Lab#sync + lifecycle
                     wiring), prompt.ts (OSC 133 PromptTracker), exec.ts (execInSession queue)
  commands/          types.ts, grammar.ts (tokenize, Line), invoke.ts, registry.ts,
                     verbs/{spawn,rm,ls,exec,sh,link,capture,focus}.ts
  agent/             webmcp.ts (detect, reconcile registration), tools.ts, approvals.ts,
                     reads.ts (shell_read, capture_read)
  ui/
    base.ts          View<Slice>, provide(env)
    styles/          tokens.css (HANDOFF block verbatim), base.css, controls.css, fonts.css
    elements/        one file per subscribing element + its co-located .css
    parts/           pure lit-html template functions: machine-row, port, capture-row,
                     confirm, suggestion, result-block, icons
    terminal/        terminal.ts (<unlab-terminal>), marks.ts (gutter layer), theme.ts
    bar/             model.ts (barReduce, pure), command-bar.ts (element)
    a11y/            announcer.ts (announcements(prev,next) → one polite region)
```

**Import rules.** `scripts/check-imports.ts` enforces these, and `npm run check`
fails when they break. That is how the red flag "importable internals" is
made unreachable rather than just discouraged.

| From ↓ may import → | domain | store | runtime | commands | agent | ui |
| --- | --- | --- | --- | --- | --- | --- |
| domain | ✓ | | | | | |
| store | ✓ | ✓ | `decode.ts`, `frames.ts` only | | | |
| runtime | ✓ | types only | ✓ | | | |
| commands | ✓ | types only | types only (`Runtime`) | ✓ | | |
| agent | ✓ | types only | | ✓ | ✓ | |
| ui | ✓ | types only | `terminal/` may import `@wterm/*`, never runtime | ✓ | `Approvals` type only | ✓ |

Every directory has an `index.ts`. Cross-directory imports must target
that `index.ts`, and the checker rejects deep paths.

### The state, and why a reducer

`LabState` (sketch `domain.ts`) is one immutable record: `machines`
(insertion-ordered `Map`, which is also rail order and the ⌘K-digit
order), `nextNode`, `panes`, `focus`, `view`, `agentPanel`, `capture`
(filter, paused, selected), `log`, `agent`, `now`, and `lanes` (three
revision counters). The invariants live in the types:

- `Lifecycle` is a discriminated union. A `reason` exists only on `failed`
  and `bootMs` only on `ready`. Each phase also carries `attempt`.
- `NetAttachment` keeps intent (`wantsNet`) apart from fact (`port`).
  Failed means `wantsNet: true, port: null` (cable withdrawn, port freed).
  `--no-net` means `wantsNet: false`. Cut means `port` is kept and `cable: 'cut'`.
- `Hue` and `PortNo` are `1..8` literal unions. `MachineName` and
  `SessionId` are branded and parsed once, by the grammar or `fromInput`.
- `LogEntry.line` is always bar grammar, so `recent` shows agent calls
  "written in bar grammar" for free.

**Change mechanism: events through one pure `reduce`.** This was chosen
over signals, Redux-with-middleware and mutable models, for three reasons.

1. *One writer.* There is a single function per invariant: hue
   allocation, lowest free port, the boot timeout, settling the panes.
   Each has exactly one caller path, per separate-before-serializing-shared-state.
2. *Idempotence by totality.* `reduce` is total. An event that does not
   apply returns `s` unchanged. Examples: `rt-ready` for a stale attempt,
   `remove` of a machine already removing, and `cable up` on an up cable.
   Two `rm`s, a doubled click, or a dead worker's late message are
   no-ops, per make-operations-idempotent.
3. *Tests are data.* A scenario is `events.reduce(reduce, initial)`. The
   whole HANDOFF lifecycle table, the tiling table and the parking rules
   become node unit tests that need no DOM.

Time enters as events. `tick { now }` is dispatched every 100 ms, and only
while something is booting or an ARP is pending. With time arriving that
way, the boot counter (`booting 1.4 s`), the boot timeout
(`startedAt + BOOT_TIMEOUT_MS <= now` → `failed: 'no prompt within 60 s'`)
and the `agent active` five-minute window are all pure.

### Lanes: how wire-speed data enters without O(buffer) work

Frames and terminal bytes never go through `reduce`. They are appended to
lanes the store owns (sketch `store.ts`, `capture.ts`), and the writer
and reader halves are separate types.

**One frame, traced.**

1. The worker sends `postMessage`. The driver calls `sw.receive`, and the
   switch forwards the frame and fires the tap synchronously.
2. The tap calls `writers.capture.frame(tap, names)`, which does five
   constant-size steps:
   - decode the header fields into a `FrameRow`, and leave `info()` lazy;
   - resolve names by MAC or IP through the ≤8-entry `NameIndex`;
   - `annotate(tap, portOf)` gives `unknown destination, flooded to port 2`;
   - register an ARP request with `ArpWatch`, or clear it on a reply;
   - `ring.push` and `filter.test` append the seq to `matches` on a hit,
     and evicting the oldest row also drops any `matches` entries older
     than the ring's first seq.
3. The store sets a dirty bit and schedules one flush.

That is O(filter terms) per frame, independent of buffer size and
subscriber count.

**The flush** runs once per animation frame. It falls back to a
`MessageChannel` turn while `document.hidden`, because rAF is suspended
in background tabs and agent calls must not hang. Each flush does three
things:

1. bumps `lanes.capture`, `lanes.sessions` and `lanes.switch` once (as
   one `lanes` event);
2. runs every subscription's selector and compares the result with
   `Object.is` (structure sharing makes that correct);
3. resolves pending `until()` predicates.

The cost per flush is O(subscribers), and the subscriber count is in the
dozens.

**Readers.** The dock selects `lanes.capture` and reads `tail(8)`. Wire
renders a virtual window over `matches` (fixed 26 px rows, so a row is
index arithmetic and nothing is measured). Changing the filter rebuilds
`matches` once, which is the only O(buffer) operation, and it runs once
per edit. Pause stops appending rows while the switch keeps counting.
Clear empties the ring and leaves the counters running.

**MAC table and counters** remain owned by `LabSwitch`. `SwitchReader` is
a read-only facade that maps port ids to `PortNo`. The switch's `version`
is compared at flush, and when it moves `lanes.switch` bumps, so the MAC
table and `frames` row re-render. No copy of the table is kept anywhere,
per "derive instead of sync".

**Session logs.** Each log is a 256 KiB byte ring addressed by *absolute
offset since the session opened*, plus `marks: LineMark { source, from,
to }` expressed in those offsets. The driver appends, and terminal
elements read and subscribe. Marks are anchored in the stream, not in
rows. That is what lets them survive remounting, reflow and replay, and
it keeps rows out of the store.

### Command registry

The contract (sketch `commands.ts`) is HANDOFF's `Command<Args>` with
five deliberate changes, all toward a deeper interface.

| Change | Why |
| --- | --- |
| `parse(line: Line, s)` takes tokens with positions plus `rest` (after `--`) | Carets need positions; `exec` needs the untouched passthrough |
| `complete(line, cursorToken, s)` | Completion is by argument position, and the token under the cursor is not always the last |
| `preview` returns `{ will, assumed }` | The bar's two lines; the approval uses `will` verbatim |
| `format(args)`, `actionLabel(args)`, `confirm?(args, s)` | Agent calls logged in bar grammar, `Remove node3` buttons, and the rm question. All are per-verb words, kept with the verb |
| `run(args, { source, signal, env })` | Commands are plain values. `env` gives them `store` and `runtime`, and tests pass fakes |

`AgentBinding<Args>` lives on the command (`agent?: {tool, inputSchema,
annotations, defaultPolicy, fromInput}`), so the tool list is *derived*
from `REGISTRY` and there is no second list (red flag "hand-synced
list"). Two read-only tools have no verb, `shell_read` and
`capture_read`, and are `ReadTool`s in `agent/reads.ts`. They read lanes
and change nothing.

**`invoke(cmd, args, ctx)` is the only caller of `run`.** It does four
things, in order:

1. re-validates against the state *now*, because a preview or a
   pending approval can be stale (if node3 was removed while the agent
   waited, the approval returns `No machine called node3.`);
2. dispatches `log-start {source, line: format(args)}`;
3. awaits `run`, converting a throw into a `LineError` shown in the same
   block;
4. dispatches `log-end`.

Confirmation is a surface policy and sits outside `invoke`:

- **bar:** first Enter → `confirm` mode; second Enter or the Remove button → run;
- **agent:** `ask` → pending;
- **button:** the inline `confirm` part.

All three take their words from `confirm()` and `actionLabel()`.

**Verbs, sketched.**

- `spawn`: `validate`, `preview` and the reducer all call one allocator,
  `planSpawn(state, …)`, so the names and ports in the preview are the
  ones the spawn takes. `run` dispatches `spawn {plan}` and returns at
  once (`close: true`), because rows and panes appear that flush.
  Port shortage produces `switch0 has 2 free ports. Add --no-net to
  boot them unplugged.` with `fix` set to the formatted line with
  `--no-net`.
- `rm`: `danger: true`. `run` dispatches `remove`, then
  `await store.until(gone, signal)`. The ordering (link down first, then
  the event row, dispose, `rt-gone`) lives in the reconciler, not here.
- `link`: dispatches `cable`. The reducer gives an unplugged machine the
  lowest free port. The reconciler applies the change to the switch and
  writes `port 3 link down` with its cause from `cableBy`. That gives the
  cause text "Cable to node3 cut by the agent." without the command
  writing capture rows.
- `exec`: resolves targets (a bare name means the active session) and
  then calls `runtime.execInSession` on each in parallel. It returns
  `close: false` with the header, machine and skipped blocks from HANDOFF.

`interpret(raw, state)` wraps tokenize → registry lookup → parse →
validate, and the bar model uses it. Errors appear "on Enter, never
while typing", a rule enforced by `barReduce`, not by the commands.

### Runtime boundary: keep, reshape, replace

| Prototype | Fate |
| --- | --- |
| `frames`, `decode`, `nic`, `image`, `guest`, `protocol`, `vm-worker` | Moved to `runtime/`, unchanged. `test/lab.test.ts` keeps passing |
| `LabSwitch` | Kept, with three changes: flushed entries are retained (ignored for forwarding, cleared on relearn, deleted on `removePort`), a `version` counter, and `TapEvent.unknownUnicast`. Port ids stay strings (the machine name). Numbering belongs to the domain |
| `Machine` | Becomes `Driver`: one worker and one switch port for **one boot attempt**, translating `FromVm` → `RuntimeEvent` tagged `{machine, attempt}` and appending bytes to session lanes. No public mutable fields, no `onChange` |
| `Session` | Split. Its data becomes `Shell` in state plus `SessionLog` in the lane. Its I/O becomes `Runtime.write/resize` |
| `Lab` | Deleted. Its naming moves to `identity.ts` (now monotonic `node<n>`, ip `.10+n`), and `#sync` becomes a reconciler rule driven by `hostsFor(state).version` |

**The reconciler** (sketch `runtime.ts`) subscribes to the store. On
every flush it diffs the desired state against its drivers and acts.
Every rule has the form "if desired ≠ actual, act", so it is idempotent,
and a half-finished teardown is repaired at the next flush.

| State says | Reconciler does |
| --- | --- |
| booting, no driver for `(name, attempt)` | dispose any stale driver; `startDriver` |
| failed, driver alive | dispose (the port leaves the switch) |
| removing | `setLink(false)` → `capture.link(port, false, …)` → `dispose()` → dispatch `rt-gone` |
| ready, `net.cable` ≠ switch link | `driver.setLink`; capture event row with the cause |
| ready, driver hosts version ≠ `hostsFor(state).version` | `pushHosts` |
| shell in state, not in driver / the reverse | `openShell` / `closeShell` |
| machine set changed | rebuild `NameIndex` |

**Lifecycle**, enforced by `reduce`:

| From | Event | To | Notes |
| --- | --- | --- | --- |
| — | `spawn` | booting(attempt 1) | row, pane and console lane created at once |
| booting | `rt-stage` | booting | stage text only |
| booting | `rt-ready` (same attempt) | ready | `bootMs` frozen |
| booting | `rt-failed` or `tick` past the deadline | failed | `port: null`; the reason is shown verbatim |
| ready | `rt-failed` (worker died) | failed | |
| failed | `boot-again` | booting(attempt+1) | same name, hue, image and memory; `lowestFreePort`; shells reset to `console` |
| booting, ready, failed | `remove` | removing | rows and panes go 50% opacity and are inert |
| removing | `rt-gone` | (deleted) | hue and port free; MAC entries deleted by `removePort` |
| removing | anything else | removing | |

"Only ready accepts commands" is a single check: `resolveTargets(expr, s,
accept)`, where each verb passes its acceptor. For `rm` the acceptor
allows booting and failed. For `link` and `exec` it requires ready.
Globs and `all` expand to ready machines only, and named non-ready
machines come back as `skipped node4: still booting`.

**`exec` mechanism.** `execInSession(session, line, source, signal)`
queues calls per session. For each call it does three things:

1. `beginMark` at the lane's current end offset;
2. writes `line + '\r'` to the pty;
3. watches `PromptTracker`, a streaming OSC 133 scanner over the
   session's own bytes, for `command-end;exitCode`, then calls
   `endMark` and resolves `{exitCode, output}`.

The output is the ANSI-stripped bytes between the mark and the prompt.

Guest setup installs a prompt that emits OSC 133 (`A`, `B`, and `D;$?`).
This also settles HANDOFF's "busy session" question: the tracker knows
whether a session is at a prompt. `validate` then refuses with `node2 is
running something in console. Nothing was changed.` and the fix is
`exec node2:sh1 -- …`.

If the step-7 spike shows the console shell cannot adopt the prompt,
the fallback is HANDOFF's echo sentinel behind the same `PromptTracker`
interface, and nothing above the runtime changes.

**Capture annotations**, all in one pure function, `annotate()`:

- an unknown or flushed unicast destination gives `unknown destination,
  flooded to port 2, 3`;
- delivery to a cut port gives `dropped, port 3 is cut`;
- broadcasts get no note, because the route reads `everyone`;
- `no reply` is set by `ArpWatch.sweep` on tick, once a request has
  waited 1 s. `FrameRow.note` is the only field written after append,
  and only `capture.ts` writes it.

### Panes as pure functions

`PaneState` holds `order`, `parked: Map<name, 'auto'|'user'>`,
`focusedAt` generation numbers, `maximised: {pane, restore} | null` and
`area`. The only DOM input is one `pane-area` event from a
ResizeObserver. `reduce` calls `settle(panes, focused)` after every
pane-affecting event, and `settle` has three rules:

- over capacity: auto-park the oldest-focused visible pane that is not
  focused;
- under capacity: un-park auto-parked panes, most recently focused first;
- never touch user-parked panes.

Maximise snapshots `parked` into `restore`, then auto-parks the rest.
Maximise again restores the snapshot exactly (minus removed machines),
then settles. Focus bumps `focusedAt` but never touches `order`, which is
how "focus never moves panes" holds by construction. `tile(names, cap)`
returns grid templates and placements, including the 3:2 main-and-stack
case. A property test (fast-check) checks two things:
`visible.length ≤ capacity` and `settle ∘ settle = settle` for random
event sequences.

**Panes never move in the DOM.** `<unlab-pane-area>` renders every pane
in creation order and positions it with `grid-row` and `grid-column`
from `tile()`. Promoting, re-tiling and parking change styles only. A
parked pane is `hidden` and its terminals have `renderingPaused`. This
matters because moving a custom element runs disconnect and connect,
which would tear down the WTerm. Terminals are destroyed only when their
session ends.

### Component layer

**Decision: `lit-html` templates plus a 60-line `View<Slice>` base, light DOM.**
The base subscribes on connect, re-renders on slice change, and gets
`env` from `provide()`. We do not use LitElement.

LitElement's two main features don't fit here:

- reactive properties: state comes from the store, so per-property
  change tracking would duplicate the selector;
- shadow-scoped styles: we rejected shadow DOM, for the reasons below.

What we need is lit-html's keyed, minimal DOM diffing. Hand-rolling that
is exactly the code we should not own. lit-html is about 3 KB, needs no
decorators or compiler step, and its directives (`repeat`, `classMap`,
`live`) cover the combobox and lists. Spec rule 5 ("custom elements,
vanilla TS") is met: every region is a real custom element with no
framework runtime.

**Elements versus parts.** An element exists where there is a
subscription or an imperative resource: app, top bar, command bar, rail,
machine details, pane area, pane, terminal, dock, switch, capture, MAC
table, frame detail, agent panel, spawn form and status line. Rows,
ports, the confirm block, suggestions and result blocks are pure
template functions in `ui/parts/`. They are unit-testable with
`render(part(x), div)` and never subscribe. The spec's attribute lists,
such as `<unlab-port number hue state>`, become part parameters.

**Why light DOM (load-bearing).**

1. **ARIA ID references don't cross shadow roots.** The combobox needs
   `aria-controls` and `aria-activedescendant` pointing into the
   suggestion listbox. Tabs need `aria-controls` pointing at tabpanels
   that hold terminals. The approval needs `aria-describedby`. In light
   DOM all of these just work.
2. wterm's DOM renderer needs its global stylesheet, and its selection
   and focus code assumes document scope.
3. Playwright locators and axe run without shadow-piercing caveats.

The cost is losing style encapsulation. We contain that with
`@layer tokens, base, controls, elements` and with element CSS scoped by
tag (`unlab-pane > header`), co-located with each element and imported
by its module.

**Tokens and styling.**

- `tokens.css` is HANDOFF's `:root` block, verbatim.
- `controls.css` defines the shared plain classes: `.btn`, `.btn.primary`,
  `.field`, `.select`, `.row`, `.seg`.
- The focus ring is defined once:
  `:focus-visible { outline: 2px solid var(--agent); outline-offset: 2px }`.
- An element that carries a hue sets
  `style="--hue: var(--hue-${n})"`, and its CSS only ever says
  `var(--hue)`.
- The "dividers are gaps" rule lives in one utility class, `.split`.
- IBM Plex Mono 400, 500 and 600 are self-hosted with `@fontsource`.
  The page is cross-origin isolated (COEP), and third-party font hosts
  would need CORP.

**Terminal mount** (sketch `ui.ts`, `TerminalElement`). The element is
`<unlab-terminal session>`, and it owns one `WTerm` over one
`GhosttyCore`, with the WASM compiled once and the theme from HANDOFF.
Options are `webmcp: false` (our tools only), `announceOutput` on for
screen readers, and the cursor solid in the focused pane and hollow in
the others. On mount it replays `log.chunks()` and subscribes to
`onData`. Keystrokes go to `runtime.write`, and input is ignored while
the machine is booting.

**Line marks.** When the element feeds bytes it splits each write at
mark offsets. After writing up to a boundary it calls
`bridge.trackPosition(bridge.getCursor())` and keeps the
`TrackedTerminalPosition`. The gutter is an absolutely positioned layer
inside the scroll container, and each rule spans
`resolve().row × 20px` from `from` to `to`, or to the cursor while the
command is still running. It is grey for bar lines and `--agent` for
agent lines. Tracked positions follow scroll and reflow, which is what
the core API is for. If a position resolves to `null` (pruned), the rule
is dropped. HANDOFF's `mark(fromRow, toRow, source)` becomes internal:
`placeMark`, driven by lane marks rather than called by commands.

**Command bar.** Its editing state is element-local, but every transition
goes through the pure `barReduce(bar, action, labState)`, which returns
`{bar, effect}`. The states from frames 1–5 (resting, empty, completing,
preview, error with carets and fix, confirm, result) and the key table
(Tab, arrows, Enter, ⌘Enter, Esc, digits, Up for history) are each a
unit test. The element maps keys to actions, runs effects through
`invoke(…, {source: 'bar'})`, and implements the combobox ARIA.

The global shortcut is a `keydown` listener on `window` in the capture
phase, so it wins before wterm's textarea: ⌘K on macOS, Ctrl+/
elsewhere. Focus return comes from the state's
`focus: {kind:'bar', returnTo}`.

**Focus as state.** `focus` in `LabState` is the truth. `<unlab-app>`
runs one effect that makes DOM focus match it: the bar input, or the
focused pane's active terminal. Clicks dispatch `focus`.

**Announcer.** A pure `announcements(prev, next)` produces sentences
(`node4 ready`, link changes, `call 8 waiting for you`), and they are
written to one polite live region. Capture is never live.

### Testing and quality gates

| Layer | Tool | What | Where |
| --- | --- | --- | --- |
| Unit | `node --test` (Node 24 strips types; tsconfig adds `erasableSyntaxOnly` so every file is strippable) + fast-check | `reduce` (lifecycle table, allocation, timeout), `panes` properties, `resolveTargets`, every verb's parse, complete, validate, preview and format (including the round-trip property `parse(format(a)) = a`), `barReduce` frames 1–5, `compileFilter`, `CaptureRing` eviction and `matches`, `annotate`, `ArpWatch`, `PromptTracker`, `announcements`, selectors, `toPcap` header, switch flushed retention | `test/unit/**` |
| Perf guard | `node --test` | 200 k synthetic taps into `CaptureWriter` with a filter set: under 300 ms total, with exactly one scheduled flush per tick of the fake scheduler | `test/unit/capture.perf.test.ts` |
| Runtime integration | `node --test` (existing) | Two real kernels in Node `worker_threads`: ping, TCP. Extended to drive the reconciler with a Node driver factory | `test/lab.test.ts` |
| Component | Playwright Test, Chromium, against `test/harness/` (a Vite page that seeds `initialState` + events and calls `provide(fakeEnv)` with a `FakeRuntime`) | Each element in each state from HANDOFF's element table; `@axe-core/playwright` on each; a few `toHaveScreenshot` checks against the artboards (rail states, port states, the bar's confirm) | `test/ui/**` |
| E2E | Playwright against `vite preview` with COOP and COEP headers and real kernels | spawn 2 → ready → `exec all -- ping -c1 node2` exit 0 with grey marks · `link down node2` → event row and flooded annotation · rm confirm → re-tile · boot timeout (test build with `BOOT_TIMEOUT_MS` overridden through `?test-boot-timeout=`) → failed → boot again · agent: `addInitScript` installs a fake `document.modelContext`, then `machines_spawn` under `ask` → approval block → click → tool resolves | `test/e2e/**` |

**Lint and format with TS 7.** typescript-eslint depends on the JS
compiler API, so it is out.

- **oxlint**, with `--type-aware` through tsgolint. tsgolint is built on
  typescript-go, the same native compiler as TS 7, so it needs no JS
  API.
- **Biome** formats only.
- **`scripts/check-imports.ts`** enforces the module map. It uses
  `oxc-parser` to read imports, which is reliable given
  `verbatimModuleSyntax`.

```jsonc
"check":   "tsc -p . && oxlint --type-aware --deny-warnings && biome format . && node scripts/check-imports.ts && node --test 'test/unit/**/*.test.ts'",
"test:ui": "playwright test -c test/ui",
"e2e":     "vite build && playwright test -c test/e2e",
"check:all": "npm run check && npm run test:ui && node --test test/lab.test.ts && npm run e2e"
```

`check` takes seconds and runs on every commit. `check:all` runs in CI
and before merging.

### Build order (HANDOFF's ten steps)

Each step leaves the app working and ends in a named verification.

1. **Tokens, styles, shell.** `git mv src/lab src/runtime`, add
   `styles/`, `View`, and `<unlab-app>` with six regions. The
   prototype's `TerminalPane` sits temporarily in the pane area.
   *Verify:* `check` passes, `lab.test.ts` passes, and a UI test asserts
   region geometry (40 / 26 / 232 px, 1 px gaps).
2. **Store, registry, reconciler, driver.** `domain/`, `store/`,
   `invoke`, and `spawn`, `rm`, `link` and `focus` wired. Existing
   buttons call `press`. *Verify:* reducer lifecycle unit tests pass,
   and the e2e test `spawn → ready → ping → rm` passes on real kernels.
3. **Rail and details, four lifecycle states.** *Verify:* component
   tests cover booting, ready, failed and removing with up, cut and
   unplugged, and the e2e test covers timeout → failed → boot again.
4. **Panes.** `panes.ts`, `<unlab-pane-area>`, tabs and `sh`.
   *Verify:* panes property tests pass. A UI test covers tilings 1–6 and
   maximise/restore. An e2e test checks that the terminal element is the
   same instance after a park and return and that its text is
   preserved.
5. **Dock.** Switch changes, capture lane, faceplate and dock rows.
   *Verify:* the switch flushed-retention unit test and the perf guard
   pass, and the e2e test covers cut → event row → `unknown destination,
   flooded`.
6. **Command bar.** *Verify:* `barReduce` frame tests and the round-trip
   property pass, and the axe combobox component test passes.
7. **`exec` with marks.** Spike OSC 133 in the console first, then
   `PromptTracker` and `execInSession`. *Verify:* `PromptTracker` unit
   tests pass, and the e2e test `exec all -- hostname` shows one block
   per machine with exit 0 and gutter rules whose row span equals the
   output height.
8. **Wire.** Filter, virtual list, MAC table, frame detail, pcap.
   *Verify:* filter unit tests pass, the e2e filter `icmp node1` shows
   `n of m frames`, and the saved pcap has the right magic number and
   frame count.
9. **WebMCP.** Tools derived from `REGISTRY`, policies, approvals,
   pause. *Verify:* the e2e fake-modelContext suite passes: run, ask,
   deny, off-unregisters, abort-removes-block, pause.
10. **Empty lab and Add machines.** The form state maps to `SpawnArgs`.
    The form shows `spawn.format(args)` as its command equivalent and
    `spawn.preview`, and submits with `press`. *Verify:* a unit test
    checks that the form's preview equals the bar's for the same args,
    and the e2e first-run test passes.

## Tradeoffs accepted

- We accept up to one frame (about 16 ms) of latency between a dispatch
  and the DOM. In exchange, rendering never happens per frame or per
  byte, and every subscriber sees a consistent state.
- We accept that `run()` does not call the kernels. A reader must know
  that the reconciler acts at the next flush. In exchange, ordering
  (link down before teardown), idempotence and crash repair live in one
  table in one file instead of in every command and button.
- We accept a large `LabEvent` union. In exchange, `reduce` is checked
  exhaustively and every state change is visible in one list.
- We accept five deviations from HANDOFF's `Command` signature (`Line`,
  `cursorToken`, `env`, `format`, `actionLabel` and `confirm`). In
  exchange, carets, agent lines in bar grammar and identical approval
  words come from the command and not from surface glue.
- We accept that `invoke` validates twice (once at preview, once at run).
  In exchange, stale approvals and stale confirms fail with the verb's
  own sentence instead of acting on a vanished machine.
- We accept losing style encapsulation in light DOM. In exchange, ARIA
  idrefs, wterm and test tooling all work across element boundaries.
- We accept that hidden parked terminals stay mounted (≤8 panes, a few
  MB). In exchange, there is no teardown and replay, and their scroll
  position survives.
- We accept that capture rows record machine names at append time, so
  history keeps a removed machine's name. That is deliberate.
- We accept one post-append mutation, `FrameRow.note` for `no reply`.
  Only `capture.ts` writes it. In exchange, no parallel annotation map
  has to be kept in sync with the ring.

## Alternatives considered

- **Keep the mutable `Machine`/`Lab` objects as the store** and have
  elements read them, adding `onChange` per object. This is shallow:
  every element would learn the classes' internal rules, and lifecycle
  would be spread across a worker callback and the UI. The spec's rules
  (monotonic names, ports kept while cut) would have two writers. The
  rules would also stay untestable without workers.
- **Fine-grained signals** (TC39 Signals polyfill or
  `@preact/signals-core`) with writable signals per machine field.
  Updates would be cheap, but "who changed this" becomes any module
  holding the signal, which is split ownership. There would be no event
  log to replay in tests, and idempotence would have to be added per
  setter. Wire-speed data still needs lanes, so signals would not even
  solve the hot path.
- **Imperative commands** (`run` calls `driver.boot()`, `sw.setLink()`
  and so on directly, then dispatches). The call chain is shorter, but
  `rm` ordering, boot-again worker replacement and stale-message
  handling get re-implemented wherever an effect starts (bar, button,
  agent, and the boot timeout), and a crash halfway leaves the state
  and the world disagreeing.
- **LitElement with shadow DOM per element**, as the spec's "adopted by
  each element" suggests. Encapsulation is real, but the combobox and
  tabs need ARIA idrefs across component boundaries, which shadow roots
  break (reference target is not shipped). wterm also needs global CSS
  and document-scope selection.
- **Marks stored as rows in the store.** This is simpler to draw, but
  rows shift with reflow, resize and scrollback pruning, and the store
  would have to know terminal geometry. Byte-offset marks with tracked
  positions push all of that into the one element that has the geometry.

## Open questions and risks

- **Can the console shell adopt the OSC 133 prompt** without visible
  noise in the boot log? For example, could the worker write the prompt
  setup to the console before posting `ready`, and does busybox ash
  expand `$?` in PS1? If not, should we accept the sentinel fallback,
  or send bar and agent `exec` to a dedicated hidden pty per machine?
- **Boot timeout:** is 60 s right on slow machines, and which runtime
  reasons should be mapped to sentences?
- **Capture capacity:** 10 000 frames (up to ~15 MB) as the default? Does
  clear reset the counters? This design says no.
- **Agent indicator after 5 minutes idle:** HANDOFF says active "until
  five minutes pass" but doesn't say what it reads then. We propose
  `agent idle`.
- **Annotation wording:** HANDOFF lists `flooded to port 2` separately
  from `unknown destination, flooded…`. Which frames get the bare form?
  This design gives broadcasts none.
- **`node<n>` beyond n = 244** runs out of the /24 at `.10+n`. Should we
  wrap, refuse, or ignore it at 8 live machines?
- **rAF throttling:** is the `MessageChannel` fallback while hidden
  enough for agents driving a background tab, or should flush always be
  microtask-scheduled with rendering split off?
- **Persistence** of policies, pane order and history. State is plain
  data except the lanes, so a later `persist` subscriber is cheap. Is it
  wanted for v1?

## Next implementation step

Write `src/domain/types.ts` and `reduce.ts` with the lifecycle,
allocation and panes rules, along with their `node --test` suites,
before any element exists. Every later step renders or drives what those
tests pin down.
