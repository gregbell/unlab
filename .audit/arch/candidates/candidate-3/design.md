# unlab front end: candidate 3 — "pure lab, two streams, one door per producer"

Sketch files (they type-check under the repo's TypeScript 7 with Lit stubbed):
`sketch/model.ts`, `sketch/capture.ts`, `sketch/commands.ts`, `sketch/runtime.ts`,
`sketch/agent.ts`, `sketch/ui.ts`, `sketch/app.ts`.

## Problem

We need to turn a working prototype (real kernels in Web Workers, a learning L2
switch on the main thread, wterm terminals) into the app the handoff
describes: one store, one command registry that three surfaces share, a
machine lifecycle with ports, hues and monotonic names, tiling with parking,
a capture with annotations, a command bar with grammar and fixes, and WebMCP
tools with approvals. All of it has to be production TypeScript with tests.

The shape is hard to get right for four reasons:

1. **Rates differ by six orders of magnitude.** A lifecycle change happens a
   few times a minute. Switch taps come in at thousands of frames a second,
   synchronously on the main thread. Console bytes arrive in bursts of
   kilobytes. If one state mechanism carries all three, it's either too slow
   for frames or too loose for the lifecycle.
2. **The prototype's runtime classes hold policy.** `Lab` allocates names and
   addresses with its own rules, which aren't the spec's (`#freeName`,
   lowest-free host number). `Machine` holds a lifecycle with an `exited`
   state the spec doesn't have. `LabSwitch` deletes flushed MAC entries and
   has no port numbers. The runtime is solid as a mechanism. Its policy has to
   move out.
3. **Three surfaces have to describe one action in the same words.** The
   bar's preview, the agent's approval block and the log line must agree,
   and must describe what will actually happen.
4. **The terminal is a stateful DOM object, not a view.** WTerm owns the VT
   state, the scrollback and the row geometry that line marks anchor to.
   Destroying it when a pane parks loses marks and state.

Constraints this design keeps: `src/lab/{frames,decode,nic,image,guest,protocol}.ts`
and `vm-worker.ts` stay as they are (moved, not rewritten), along with the
Node integration test. The toolchain is Vite 8 with oxc, and TypeScript 7 is
the native compiler, so no tool may depend on the JS TypeScript API. Lit is
used without decorators. COOP/COEP stay on.

## Usage (caller's view)

### README for a contributor

> **unlab's front end is a pure lab with a thin shell around it.**
>
> - `src/model/` is the lab: plain data plus `update(state, event) → { state, effects }`.
>   It decides everything: names, hues, ports, lifecycle, panes, the boot
>   timeout. It has no DOM, no workers, no timers and no clock. You test it
>   with `node --test`.
> - `src/runtime/` does what effects say (boot a worker, plug a port, open a pty)
>   and reports what happened as events. It decides nothing.
> - Frames and terminal bytes never pass through `update`. Frames go to
>   `src/capture/` (a ring buffer with an incremental filter index). Bytes go
>   to the session's screen (`runtime/screens.ts`).
> - Every action is a command in `src/commands/verbs/`. Writing one means
>   writing a grammar, a `plan`, a `describe` and an `execute`. The bar, the
>   buttons and the agent tools derive from it.
> - Elements in `src/ui/` are Lit, in light DOM. They read through
>   `new Select(this, selector)`, act through `app.commands.<verb>.run(...)`,
>   and record pure UI facts through `app.ui(event)`. They have no way to
>   dispatch anything else.

### Call site 1: a button (machine details, "cut cable")

```ts
// ui/rail/machine-details.ts
#m = new Select(this, (s) => selectDetails(s));
render() {
  const m = this.#m.value;
  if (!m) return nothing;
  return html`
    <button class="btn" ?disabled=${!m.accepts.link}
      @click=${() => this.app.commands.link.run(
        { dir: m.link === 'up' ? 'down' : 'up', targets: one(m.name) },
        { source: 'button', signal: AbortSignal.timeout(5_000) })}>
      ${m.link === 'up' ? 'cut cable' : 'reconnect'}
    </button>
    <button class="btn danger" @click=${() => this.app.confirmInBar(`rm ${m.name}`, 'button')}>remove</button>`;
}
```

`rm` is `danger: true`, so `this.app.commands.rm.run(args, { source: 'button', signal })`
**doesn't compile**: `RunContextFor<true>` requires an `approval`. A button
reaches it through `confirmInBar`, which opens the bar already showing the
confirm block. That gives every surface one confirmation UI.

### Call site 2: the bar on Enter

```ts
// ui/command-bar/element.ts — the element only forwards keys and performs outputs
const { state, out } = barStep(this.#bar, { key: 'enter' }, this.app.store.state, this.app.commands);
this.#bar = state;
for (const o of out) {
  if (o.do === 'run') {
    const p = parseLine(this.app.commands, o.line, this.app.store.state);   // already known valid
    if (isLineError(p)) continue;
    const result = await p.command.run(p.parsed.args, { source: 'bar', signal: this.#abort.signal, ...(o.approval && { approval: o.approval }) });
    this.#bar = barResult(this.#bar, result);   // 'visible' closes; 'report' stays; 'failed' shows the error block
  }
}
```

### Call site 3: an agent tool

```ts
// agent/tools.ts — machines_remove is a binding, not an implementation
machines_remove: bindVerb('rm', {
  tool: 'machines_remove',
  description: 'Remove machines and their disks.',
  annotations: { consequentialHint: true },
  toLine: (i) => line('rm', [list(i, 'names')]),   // → 'rm node3'  (each scalar must be one token)
}),
```

The pipeline in `createAgent` is tool input → bar line → `parseLine` →
`validate` → policy (ask means a pending call carrying `preview(...)` and
`confirm(...).actionLabel`) → `run({ source: 'agent', approval })`. The agent
gets the verb's own error sentences. `recent` shows `rm node3` with the blue
rule, because the line is what got logged.

### Call site 4: a model test

```ts
test('boot again takes the lowest free port and keeps name and hue', () => {
  let s = labWith(['node1', 'node2', 'node3']);                 // ports 1,2,3
  s = run(s, { type: 'vm/failed', machine: 'node2', attempt: 1, reason: 'kernel panic' });
  assert.equal(s.machines.node2!.phase, 'failed');               // port 2 freed
  s = run(s, spawnEvent(s, 1));                                  // node4 takes port 2
  s = run(s, cmdBootAgain('node2'));
  assert.deepEqual(pick(s.machines.node2!), { phase: 'booting', attempt: 2, plug: { kind: 'port', port: 4, link: 'up' }, hue: 2 });
  assert.equal(run(s, { type: 'vm/ready', machine: 'node2', attempt: 1, bootMs: 9 }), s); // stale attempt: no-op
});
```

## Shape

### Module map

```
src/
  main.ts            composition root: builds store, capture, screens, engine, registry, agent; mounts <unlab-app>
  services.ts        types only: AppServices (what elements may touch), ExecPort, RuntimeReads
  net/               pure packet code for page, worker and Node: frames.ts, decode.ts (moved from lab/), filter.ts, pcap.ts
  model/             the pure lab
    state.ts         LabState and its parts
    events.ts        RuntimeEvent | CommandEvent | UiEvent | AgentEvent
    effects.ts       Effect
    update.ts        the reducer: a switch delegating to slice functions, then reconcilePanes
    machines.ts      identity arithmetic, lifecycle table, allocation (ports, hues), plans
    panes.ts         reconcile/focus/park/maximise/promote/resize (pure)
    tiling.ts        visible panes + grid → CSS grid template
    selectors.ts     memoised read models: rail, details, ports, tiling, status, recent, history, indicator
    store.ts         createStore (≈60 lines): state, narrowed dispatchers, subscribe, until, FIFO effects
  capture/           CaptureLog: ring, match index, ARP no-reply tracker, link rows, rAF notify; CaptureView for readers
  commands/
    grammar/         tokenize, slots, parseLine, complete, fix (edit distance), format
    verbs/           spawn rm ls exec sh link capture focus boot — one file each, ≈60-120 lines
    define.ts        defineVerb: derives signature, validate, preview, run (+ logging)
    approval.ts      grantApproval — not re-exported; only ui/command-bar and agent/ may import it
    index.ts         createRegistry (the one verb list), parseLine, types
  agent/             detectModelContext, tool table (5 verb bindings + 2 queries), policies, pending answers, registration reconcile
  runtime/
    engine.ts        effect executor, id maps (machine→vm, session→sid, port→machine), byte and frame paths
    vm.ts            one Worker per boot attempt (was Machine); protocol stays private here
    switch.ts        LabSwitch, reshaped: numbered ports, flushed retention, bitmask taps
    shell-tracker.ts OSC 133 scanner (pure)
    screens.ts       WTerm + GhosttyCore per session, garage, line marks
    theme.ts         terminal theme (the handoff's 16 colours, renamed to wterm's keys)
    nic.ts image.ts guest.ts protocol.ts   moved from lab/, unchanged except guest.ts's prompt snippet
  workers/vm-worker.ts  unchanged apart from import paths
  ui/
    base/            UnlabElement (light DOM + context), Select, FollowCapture, hue helpers
    styles/          tokens.css (the handoff block verbatim), base.css (reset, controls, focus ring), fonts.css
    app/ top-bar/ command-bar/ (element.ts + model.ts) rail/ pane-area/ pane/ terminal/
    dock/ switch/ capture/ wire/ agent-panel/ spawn-form/ status-line/ confirm/ announcer/
```

**Who may import what.** This is enforced by `scripts/check-imports.ts` in
`npm run check`, with the matrix as data in `sketch/app.ts` `LAYERS`:

| Layer | May import |
| --- | --- |
| net | nothing |
| model | net |
| capture | net, model |
| commands | net, model |
| runtime | net, model, capture, commands (ExecPort types) |
| agent | model, capture, commands |
| ui | net, model, commands, services (types) — **never runtime, capture internals or agent** |
| workers | net, runtime's worker-side files |
| main.ts | everything |

Imports across directories go through each directory's `index.ts`. A deep
import fails the check, which keeps internals unreachable (red flag:
importable internals). `commands/approval.ts` is the one named exception.

### Data structures first

Everything is in `sketch/model.ts`. These choices carry the rest of the design.

- **Names are ids.** `MachineName = \`node${number}\``, and n only goes up.
  `SessionId = \`node2:sh1\`` is both the key and the address the user types.
  Both are unique for the lab's lifetime, so there's no separate id space and
  no id→name lookup.
- **Identity is arithmetic.** node n is `10.88.0.(10+n)` with `labMac(10+n)`,
  the spec's rule. That replaces the prototype's lowest-free host number.
  Since names are never reused, `nameForMac(bytes)` and `nameForIp(u32)` name
  any frame's machine forever, including removed ones. Capture needs no
  identity table, and old rows stay correct after `rm`. A removed machine's
  name prints in plain text because its hue may belong to someone else now.
- **The lifecycle is a discriminated union, and the variant carries the port.**
  `booting` and `ready` carry `plug: Plug`. `failed` has no plug field, so a
  failed machine *can't* hold a port. `removing` carries `port | null` with
  the link already down, so nobody else can take the port mid-teardown. The
  free-port set is derived (`takenPorts`), never stored, so it can't drift.
- **Hues are derived the same way.** Every machine record holds its hue. The
  first free hue is `HUES` minus the hues in use, and it frees when the
  record is deleted.
- **`attempt` stamps every runtime event.** Boot again bumps it. A late
  `vm/ready` from a terminated worker carries the old attempt and the reducer
  ignores it. That's how "crash halfway" and "message twice" stay harmless.
- **Time is data.** `state.now` advances only on `tick`. The boot timeout is
  a check in the `tick` handler (`now - since > BOOT_TIMEOUT_MS`), not a timer
  effect, so a stale timeout can't fail a later attempt. The `booting 1.4 s`
  counter, `agent active` (5 minutes since `lastCallAt`) and MAC `seen 1 s ago`
  are selectors over `now`. The clock runs at 10 Hz while anything boots
  (the counter shows tenths) and 1 Hz otherwise. The reducer switches the
  rate with a `clock` effect.
- **Panes are order + parking + focus stamps.** `order` is the tiling order.
  `parked` maps a machine to `'auto' | 'user'`, and absent means visible.
  `focusStamp` comes from a monotonic `focusClock`, which gives a
  deterministic LRU. `maximised` holds the exact `parked` map to restore.
  `grid` comes from the area size. Visible panes and the layout are derived.

The dominant access patterns, traced through these structures:

| Pattern | Path | Cost |
| --- | --- | --- |
| Frame at 2 kHz | worker msg → `Vm.frame` → `sw.receive(port)` → tap → `capture.appendFrame` | O(1) + O(filter terms); no reducer, no allocation beyond the switch's one snapshot |
| Dock repaint | capture notifies ≤ once per animation frame → `<unlab-capture>` renders `tail(8)` → decode 8 frames | O(8) per frame of animation, whatever the packet rate |
| `9 of 191 frames` | `matchCount` | O(1) |
| Console burst | worker msg → `tracker.scan(bytes)` → `screen.write(bytes)`; store touched only when the shell phase *changes* | O(bytes) |
| Rail row re-render | dispatch → subscribers compare memoised slices → Lit batches per microtask | O(subscribers) reference compares |
| Window crosses 1200 px | `ui/area-resized` → `resizeArea` → `reconcilePanes` parks the oldest-focused pane | O(panes) |
| `rm node3` confirmed | `cmd/remove` → removing + effects `link/set down`, `vm/stop` → `vm/stopped` → record deleted, port and hue freed, panes re-tile | 2 events |

### State changes: one reducer, four narrowed doors

`update(state, event) → { state, effects }` is the only function that
changes `LabState`. `createStore` holds the state, applies events
synchronously (a command can read its own result straight away), notifies
subscribers, then runs the effects. A dispatch made while effects are
running is queued FIFO, so effect order follows event order even when a
test fake reports synchronously.

The event union has four producers. **Each producer gets only its own
dispatch** (`dispatchRuntime`, `dispatchCommand`, `dispatchUi`,
`dispatchAgent`):

- `RuntimeEvent` comes from the engine: `vm/stage|ready|failed|stopped`,
  `session/opened|ended|shell|marked`, `tick`.
- `CommandEvent` comes from verb `execute` functions: `cmd/spawn` carries a
  `SpawnPlan`, plus `cmd/remove`, `cmd/link`, `cmd/shell`, `cmd/focus`,
  `cmd/capture`, `cmd/boot-again` and `cmd/logged`.
- `UiEvent` comes from elements, through `app.ui`. These are pure UI facts:
  focus observed, tab selected, park, unpark, area resized, view, agent
  panel, bar open, capture filter, pause, clear, frame selected, policy, and
  tools paused. None of them can touch a machine, a port or a link.
- `AgentEvent` comes from agent/: calls and settlements.

The spec's rule "elements never change state directly" becomes a type:
`AppServices` exposes `ui: (e: UiEvent) => void` and a `ReadStore`, and no
other dispatcher. Spawning from an element only compiles through
`commands.spawn.run`.

**Effects** (`sketch/model.ts`, `Effect`): `vm/boot`, `vm/stop`,
`port/attach`, `port/detach`, `link/set`, `pty/open`, `pty/close`,
`screen/create`, `screen/dispose`, `screen/focus`, `hosts/publish`,
`capture/clear`, `announce`, `clock`. They're plain data, so update tests
assert on them directly. Example: removal emits `link/set down` *before*
`vm/stop`, so neighbours see the link drop first, as the States sheet asks.

**Subscriptions.** Selectors are memoised on their input slices (a tiny
local `createSelector`, about 30 lines, no reselect dependency), so derived
arrays keep their identity until an input changes. `Select<T>` (a Lit
`ReactiveController`, `sketch/ui.ts`) subscribes on connect, unsubscribes on
disconnect, and calls `requestUpdate()` only when `equals(prev, next)`
fails. Lit coalesces renders to one per microtask.

### The two streams that bypass the reducer

**Capture** (`sketch/capture.ts`). The engine is the only writer; elements and `capture_read` see a read-only `CaptureView`.

| Part | How |
| --- | --- |
| Ring | `CaptureEntry` (frame or link row), bounded by 10,000 entries and 16 MiB (open question). `seq` is monotonic, so `entry(seq)` is O(1). |
| Match index | A growable `Int32Array` of matching seqs. Append tests only the new entry; eviction trims the front; a filter change rebuilds once. Wire's virtualiser reads `window(from, count)` over it; the count is its length. |
| Filter and pause | Store state, *pulled*: the log reads `config().paused` on append and rebuilds when `config().filter` changes by reference (`selectCaptureConfig` memoises `compileFilter` on the text). Nothing is copied in, so there's no second owner. A bad term keeps the last good filter and turns the field red. |
| Predicate | Over raw bytes and ports: ethertype and IP protocol bytes, MAC/IP arithmetic at both ends, `port:3` on ingress or the egress bitmask. No decode, no strings per frame. |
| Annotations | `flooded` and `unknownDst` come from the tap. "No reply": a `Map<"spa>tpa", seq>`, cleared by the reply; `sweep(now)` on the tick annotates requests older than 1 s and bumps `revision`. Per tick, not per frame. |
| Link rows | Appended by the engine in the same handler that calls `sw.setLink`, with `cause` (`Cable to node3 cut by the agent.`). |
| Notify and rows | At most once per animation frame (`schedule` is injectable for tests). `CaptureRow` is built for visible rows only: decode is O(visible); route ends resolve by arithmetic and take a hue only while the machine is live. |

**Terminal bytes.** Bytes go from the worker to `ShellTracker.scan` to
`Screen.write`. The scrollback is the VT core's own (5,000 lines). The
prototype's `Session.scrollback` byte array is gone, along with its replay
path.

### The runtime boundary

The prototype's runtime classes are kept, reshaped or retired as follows
(`sketch/runtime.ts` has the details):

| Prototype | Fate | Why |
| --- | --- | --- |
| `Lab` | **Retired** | Its allocation rules contradict the spec, and its policy belongs in model/. `#sync` (hosts versioning) becomes the `hosts/publish` effect. The engine keeps the latest table and pushes it to every ready vm, and to a vm in its own `ready` callback, so a machine that was mid-boot during a change still converges. `setupScript` is idempotent already. |
| `Machine` | **Reshaped into `Vm`** | One Worker for one boot attempt. Its callbacks are stamped with the attempt. No state, no mutable name, no `onChange`. `FromVm`/`ToVm` stay private to vm.ts. Worker error, image failure, a fatal error and guest exit all become `failed(reason)` with the runtime's sentence verbatim. There's no `exited` state. `stop()` sends `stop`, terminates after 250 ms, and is idempotent. |
| `Session` | **Retired** | Session metadata (kind, label, open, shell phase, agentLines) is model state. Bytes go straight to Screens. Write and resize go through the engine's session→sid map. |
| `LabSwitch` | **Kept, three edits** | (1) Ports are keyed by `PortNo`, so the faceplate number *is* the switch port. (2) `setLink(down)` marks entries `flushed` instead of deleting them: forwarding ignores flushed entries, so frames to the cut machine flood and the tap reports `unknownDst`. Relearning clears the flag, and `detach` deletes the entry. (3) `toPorts` becomes a bitmask, and the tap adds `unknownDst`. The existing unit-level behaviour and the Node ping test still pass. |
| frames, decode, nic, image, guest, protocol, vm-worker | **Kept** | frames and decode move to `net/`. guest.ts gains the prompt snippet (see exec). |

**Port numbering 1-8.** `lowestFreePorts(state, k)` is derived from
`takenPorts`. A spawn plans its ports up front, and the preview states them.
A machine keeps its port while cut (`plug.link = 'cut'`). `--no-net` gives
`plug: none`, and `link up` plans the lowest free port, which the engine
attaches with `port/attach`. A failed machine's port is freed by the type.
Boot again plans a fresh lowest port.

**Lifecycle state machine** (the table in `sketch/model.ts`). It's tested
exhaustively: every phase × every event, with unknown or stale ones as
no-ops.

```
booting --vm/ready(a)--> ready                 announce "node4 ready"; hosts/publish
booting --vm/failed(a) | tick past timeout--> failed    vm/stop, port/detach, announce
ready   --vm/failed(a)--> failed               (guest powered off counts)
failed  --cmd/boot-again--> booting(a+1)       same name, hue, image, mem; lowest free port
booting|ready|failed --cmd/remove--> removing  link/set down (event row) then vm/stop
removing --vm/stopped(a)--> (deleted)          port/detach, screen/dispose×n, hosts/publish; panes re-tile
```

Only `ready` accepts commands. Slots enforce this: `machines({ phases })`
expands `all` and globs over the allowed phases and records
`skipped node4: still booting`.

The boot timeout is 120 s by default and starts at spawn (open question). A
cold image fetch counts against it, because the image is shared and fetched
once.

### Commands

`Command<Args, D>` (`sketch/commands.ts`) is the spec's interface plus
`format` and `confirm`. A verb author writes a `VerbDefinition`:

- `grammar` is an ordered record of slots (`count`, `image`, `machines`,
  `target`, `choice`, `option`, `exclusive`, `flag`, `rest`, `passthrough`).
  From it we derive `signature`, `parse`, `complete` by argument position,
  `format` (the inverse of parse, property-tested), the "Left out, so
  assumed" defaults, and the agent tool's JSON schema.
- `plan(args, lab)` is pure and is where the verb decides anything. Errors
  are sentences in the verb's words. Model-level plan errors (`no-ports`,
  `unknown-machine`) become sentences once, in `sentence()`.
- `describe(plan, lab)` produces the `will …` text.
- `confirm` is present only when `danger: true`.
- `execute(plan, ctx, deps)` dispatches, waits until the effect is visible
  (`store.until`), and returns a `Result`.

`defineVerb` derives the rest:

- `validate(a, lab)` is `plan` returning an error.
- `preview(a, lab)` is `describe(plan)` plus the assumed line, with a warn
  tone when the verb is dangerous.
- `run(a, ctx)` **re-plans against the current state** (an approval can land
  minutes after its preview), executes, and dispatches
  `cmd/logged { line: format(a), source, outcome }`.

The result: **the preview, the approval block and the reducer all read one
`Plan` object**, so their words can't drift from what happens. The
"did you mean" fix is generic. The grammar knows which suggestions the
failing position expects (`Slot.expected`). If exactly one is within edit
distance 2, `fix` is the line with that token replaced. Verbs never write
fixes.

**Confirmation is in the type.** A danger verb's run takes
`RunContextFor<true>`, which requires an `Approval`. Only
`commands/approval.ts` mints one, and only the bar model and the agent
module may import it. The bar mints one on the second Enter (or the Remove
button). The agent mints one on Allow, or from a standing `run` policy the
user set themselves. Buttons route through `confirmInBar`.

**Results.** `visible` closes the bar (`spawn`, `link`, `sh`, `focus`,
`capture`, `rm`, `boot`). `report` keeps the bar open with blocks (`ls`,
`exec`). `failed` shows a `LineError`, the same block as a parse error,
ending in "Nothing was changed."

**History.** `state.log` keeps the last 200 entries (open question). `recent`
is the last three entries from the bar or the agent. Button clicks such as
rail-row focus are logged but kept out of `recent`, so they don't crowd it.
The up arrow walks `source === 'bar'` lines only.

**The four verbs sketched** (in `sketch/commands.ts`):

| Verb | Grammar | Plan | Execute |
| --- | --- | --- | --- |
| `spawn` | count, image, `--mem`, `exclusive(--net switch0, --no-net)` | `planSpawn`: names from `nextN`, first free hues, lowest free ports; sentences for no ports or no hues | dispatch `cmd/spawn`; return at once (every row and pane appears booting) |
| `link` | `choice(up, down)`, `machines({ phases: ['ready'] })` | `planLink`; up on an unplugged machine allocates a port | dispatch `cmd/link` with `cause = source` |
| `rm` | `machines({ phases: ['booting','ready','failed'] })`; `danger: true` | ports to free; `confirm` names the machine, what is lost, the neighbours affected | dispatch, then `until(records gone)`: "closes when teardown ends" |
| `exec` | machines or sessions, then `passthrough` | bare name → active session; skip booting machines and sessions whose shell phase is `running` (the answer to "exec into a busy session": detect and refuse, per target) | `exec.inject` in parallel; one `ReportBlock` per machine; header `ran in 3 consoles in 1.0 s · 2 failed` |

### exec, exit codes and line marks

`ExecPort.inject(session, line, source, signal)` runs in the engine:

1. If the session's `ShellTracker.phase` is `running`, it rejects with a
   sentence.
2. It calls `mark = screen.beginMark(tone)`, where tone is `agent` for the
   agent and `bar` (grey) otherwise. For the agent it also dispatches
   `session/marked`, which drives the pane's `blue rule: sent by the agent`
   legend.
3. It types `line + '\r'` into the session, exactly as typed. The shell's
   state (cwd, env, history) is the user's, as the handoff decided.
4. It waits for the tracker's next `finished` mark (OSC 133 `D;code`), with
   FIFO matching of pending injects per session.
5. It reads the output with `mark.end()`, which takes the text of the marked
   rows minus the echoed first row from the screen (so no escape codes), and
   resolves `{ exitCode, output, ms }`.

Exit codes come from **OSC 133 emitted by the guest's prompt**. guest.ts's
setup writes `/etc/profile.d/unlab.sh` (and `ENV` for ash) so that PS1
emits `D;$?` then `A`, with `B` after the prompt. The tracker is a pure byte
scanner on the main thread. It carries partial sequences across chunks, and
it also tells exec when a session is busy and tells a mark where to end. It
doesn't depend on the renderer. If a guest emits no OSC 133, the mark ends
after 30 s or at abort, with `exitCode: null`, shown as `exit ?`. That's a
visible degradation, not a wrong answer. The bigger risk is getting the
console's login shell to source the snippet when it started before setup;
it's listed under Open questions.

**Line marks are anchored by the VT core, not by byte offsets.**
`beginMark` takes `core.trackPosition(cursor)`, and `end` takes another one.
`TrackedTerminalPosition` follows scrolling and reflow, and resolves to null
when the rows fall out of scrollback, at which point the mark is dropped.
Drawing works like this: the screen's element has an overlay layer with one
absolutely positioned 2px rule per *visible* mark, recomputed from row
height and scroll offset after each WTerm render. It sits inside the 14px
gutter, and the stream itself is never altered. The spec's
`<unlab-terminal>.mark(fromRow, toRow, source)` is kept as a thin method for
fixtures.

### Screens: one per session, for the session's whole life

`runtime/screens.ts` creates a WTerm + GhosttyCore when a session opens
(`screen/create`) and destroys it when the session ends. The WASM module is
compiled once. A screen that no `<unlab-terminal>` is showing sits in the
**garage**: an off-screen, laid-out, `inert`, `aria-hidden` container (WTerm
needs layout to measure), with `renderingPaused: true`. As a result:

- Parking, tab switches and maximise never destroy terminal state, so
  there's no replay path.
- Marks keep their tracked positions and `shell_read` works for hidden
  sessions.
- `<unlab-terminal>` is a socket. On connect it calls `screen.attach(this)`,
  which moves the element in, unpauses and fits. On disconnect it calls
  `detach()`. When the `session` property changes, it swaps screens.

The theme comes from `setThemeColors(terminalTheme)` per screen. The font
is the `--font` token at 12.5/20. The cursor is a solid block when the
pane is focused and hollow otherwise (`setFocusedStyle`). The built-in
`webmcp` option stays off, because our tools are the interface. The
screen-reader mode is `announceOutput: false` (the spec bans a chatty live
region), with WTerm's accessible DOM text left on.

### Panes

These are all pure functions in `model/panes.ts`, and `reconcilePanes` runs
after every event that affects panes:

1. While visible > capacity, it parks the visible pane with the oldest
   focus stamp, as `auto`.
2. While there's room, it unparks `auto` panes, newest focus stamp first.
   `user` panes stay parked.

It never reorders `order`, and it's idempotent. Capacity is
`cols × rows`, with `cols = clamp(floor(w/400), 1, 3)` and
`rows = clamp(floor(h/200), 1, 2)`. Capacity is 1 while maximised.

- `focusPane` stamps the pane. A parked pane comes back first; if there's
  no room, the oldest-focused *other* pane parks in exchange. Focus never
  moves panes.
- `toggleMaximise` saves `parked`, parks the others as `auto`, and later
  restores exactly. Machines removed in the meantime drop out; machines
  added in the meantime keep their reconciled state.
- `promotePane` (`--main`) moves a pane to the front of `order`.
- `tile(visible, grid)` is table-driven over a 6-track CSS grid, so
  "3 across" and "2 across" rows share one grid. The three-pane layout uses
  `3fr 2fr`, which lines up with the dock's 3:2 split.

Property tests (fast-check) check that visible ≤ capacity, that `order` is
unchanged by focus, that maximise then restore is the identity, that
reconcile is idempotent, and that user-parked panes never unpark on resize.

### Component layer

**Lit 3, light DOM everywhere, no decorators.** Reactive properties use
`static properties` with `declare` fields, because an initialised class field
shadows Lit's accessor under `useDefineForClassFields` and the element never
updates. Most elements have one property, a key such as `machine`, and select
the rest. Services arrive through `@lit/context`'s `ContextConsumer`; the
provider is `<unlab-app>` or a test fixture.

**Why Lit over hand-rolled.** The UI is mostly keyed lists that change: rail
rows, tabs, ports, capture rows, suggestions, the call log. Efficient
template diffing is the work, and hand-rolling it means maintaining a
renderer, which isn't this product's job. Lit is about 5 KB, it *is* custom
elements (the owner's decision holds), and its `ReactiveController` is
exactly the shape of a store subscription.

**Why light DOM over shadow DOM.** Three concrete failures decided it:

- ARIA ID references don't cross shadow roots: the combobox's
  `aria-activedescendant` and `aria-controls`, the error block's
  `aria-describedby`, and focus return across regions.
- WTerm ships a global stylesheet and does selection work against
  `document`.
- Playwright and axe have less to pierce.

The cost is style encapsulation. One cascade contains it:
`@layer tokens, base, components`, with each element's CSS co-located and
wrapped in `@scope (unlab-x) to (unlab-terminal)`. No element takes arbitrary
content, so `<slot>` isn't missed.

| Concern | Decision |
| --- | --- |
| Tokens and shared styles | `styles/tokens.css` is the handoff block verbatim. `styles/base.css` holds the control classes (`.btn`, `.btn-primary`, `.field`, `.select`, `.row`), "dividers are gaps" (a `--line` container with `gap: 1px`), and the one focus ring (`:focus-visible { outline: 2px solid var(--agent); outline-offset: 2px }`). |
| Hues | Elements set `style="--h: var(--hue-N)"`; CSS uses `var(--h)` for name, bar and cable, never for a fill. |
| Fonts | IBM Plex Mono 400/500/600, self-hosted as woff2. Under COEP `require-corp`, Google Fonts would need CORP headers we don't control. |
| Command bar | `ui/command-bar/model.ts`: pure `barStep(state, key, lab, registry) → { state, out }` over every artboard state (resting, empty with recent, completing, preview, error with carets and fix, confirm, running, result). The element renders it and performs `run`, `focus` and `close`. Errors only on Enter; any edit cancels a confirmation; ⌘Enter keeps the bar open; 1-8 on an empty input focuses that rail index. |
| Global shortcut | `<unlab-app>` listens in the capture phase on `window` (⌘K on macOS, Ctrl+/ elsewhere) before the terminal sees the key, and dispatches `ui/bar`. `state.keyboard.returnTo` restores focus on close. |
| Accessibility | One `<unlab-announcer>` polite region, fed by `announce` effects (machine state, links, new approvals); the capture list is not live. Tabs use tablist, tab and tabpanel with arrow keys; choices use radio groups; each port column is one `<button>` labelled with `PortView.actionLabel`. |

### WebMCP

`sketch/agent.ts` covers this.

- **Detection.** `detectModelContext` checks `document.modelContext`, then
  `navigator.modelContext`, and otherwise returns null and the module does
  nothing.
- **The tool table derives from the registry.** Five tools are verb
  bindings: `machines_list` (ls), `machines_spawn`, `machines_remove`,
  `shell_exec`, `link_set`. Two are queries: `shell_read` reads
  `Screen.lastLines`, and `capture_read` takes the filter, compiles it with
  the same `compileFilter`, and reads `CaptureView.frames()` as rows.
- **Registration is a reconcile.** On every store change, the desired set
  is policy ≠ off and not paused. Each registered tool has its own
  AbortController, so `off` and "pause tools" just abort.
- **Approvals.** The store holds the waiting call's *data*: the line, the
  preview from `command.preview`, and the action label from
  `command.confirm` (`Remove node3`). The resolver lives in a private
  `Map<callId, resolve>`. An abort settles the call as `aborted`, and its
  block disappears. Calls never time out on their own.
- **Agent active** is a selector: `now - lastCallAt < 5 min`.

### Testing and quality gates

| Layer | Tool | What |
| --- | --- | --- |
| Unit (most tests) | `node --test` (Node 24 strips types natively, as the repo already does) + `fast-check` | model: lifecycle table, allocation, plans, panes properties, tiling table, selectors (status line wording, rail words); capture: ring, eviction, match index vs a brute-force oracle, ARP no-reply with a stepped clock, link rows; net: filter grammar, pcap bytes; commands: tokenize, every verb's parse/complete/validate/preview, `parse ∘ format` roundtrip, fix suggestions, `run` against a store with a fake ExecPort; bar model: every artboard state as a key sequence; agent: policy flows with a fake ModelContext (ask → allow, deny, abort, off, pause); shell tracker: OSC 133 split across chunks; engine: effects against a fake `startVm` and a real `LabSwitch` |
| Runtime integration | `node --test` (existing `test/lab.test.ts`) | two real kernels over the reshaped switch, plus flushed-entry retention and the `unknownDst` flood |
| Component | Playwright Test against `test/fixtures.html?f=<name>` on Vite | each element in each state the handoff lists, rendered from a fixture store (an `initialState` plus a scripted event list) with a fake engine; `toHaveScreenshot` against approved baselines; `@axe-core/playwright` on every fixture; keyboard paths (combobox, tabs, focus return) |
| E2E (real kernels) | Playwright Test, Chromium from `~/.cache/ms-playwright`, against `vite preview` (COOP/COEP) | spawn 2 → both `ready`; `exec all -- ping -c1 node2` → two `exit 0` blocks + grey marks; cut node2 → `port 2 link down` row, `unknown destination, flooded`, status segment `--down`; reconnect; `rm node2` → confirm → gone → re-tile; agent: `addInitScript` installs a fake `document.modelContext`, the test calls `machines_remove.execute` → approval block → click `Remove node1` → promise resolves; boot failure via a `?image=broken` fixture |

**Tooling, chosen for TS 7.** Anything built on the JS TypeScript API
(typescript-eslint, lit-analyzer, ts-morph-based tools) is out.

- `tsc` (tsgo) handles types, with the tsconfig tightened:
  `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and
  `noImplicitOverride`.
- `oxlint` handles lint, with `--type-aware` through tsgolint, which is
  built on typescript-go. If tsgolint lags the TS 7 release, drop the flag
  and keep the syntactic rules; tsc strict covers most of the gap.
- `oxfmt` handles formatting, from the same oxc toolchain as Vite 8. Biome
  is the fallback if it isn't stable enough.
- `scripts/check-imports.ts` handles layering (with its own unit test).
- Playwright transpiles tests itself and doesn't need the TS API.

**Scripts.**

- `npm run check` is format check, lint, `tsc -p .`, `check-imports`, then
  `node --test test/unit`. It's the fast gate (< 20 s) and runs on
  pre-commit.
- `npm run test:components` runs Playwright fixtures (~30 s).
- `npm run test:runtime` runs the Node kernel test (~8 s).
- `npm run test:e2e` runs real kernels in Chromium (~2 min, needs
  `npm run distros`).
- `npm run check:all` runs all of the above, and CI runs it.

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept **two state mechanisms** (the reducer, and append-only streams
  for frames and bytes) in exchange for O(1) frame ingest and a reducer that
  only ever sees discrete facts. The rule is written down: if it arrives
  more than about 10 times a second, it's a stream. The filter and pause
  still live in the store and are pulled, so nothing is owned twice.
- We accept **WTerm instances that live for the whole session**, including
  hidden ones in the garage. That costs memory, about one core per session,
  with 8 machines and a few shells each. In exchange there's no replay path,
  marks stay stable, and hidden sessions can still be read.
- We accept **light DOM and the loss of style encapsulation** in exchange
  for working ARIA references, an unmodified WTerm, and one cascade.
  `@scope` and `@layer` contain the leakage.
- We accept that **MAC table and counters are pulled from the switch** on
  the 1 Hz tick while visible, rather than mirrored into state. The switch
  owns forwarding, so it owns the table. A copy in the store would be a
  second owner.
- We accept **re-planning at run time**, so an approval can produce a
  slightly different outcome than its preview (for example, a port taken
  meanwhile). The result reports what actually happened, and a plan that no
  longer validates returns the error instead of running.
- We accept **adding a `boot` verb** that the handoff doesn't list. "Boot
  again" changes lifecycle, and rule 5 says every such action is a command.
- We accept that **exec exit codes depend on a guest prompt snippet**. When
  it's missing, the result degrades to `exit ?` rather than lying.
- We accept that **the reducer is a long switch** (about 30 event types).
  It delegates to slice functions, and the length buys one file in which
  every state change is visible.

## Alternatives considered

- **Signals (fine-grained reactive cells per machine and session).** These
  make subscriptions cheap without memoised selectors. But state changes
  then scatter across setters in commands, the runtime and the UI. The
  lifecycle stops being one table, cross-slice invariants (ports versus
  lifecycle versus panes) need effects that react to effects, and "elements
  never write" becomes a convention. The interface looks smaller but
  exposes write access everywhere. It loses on single ownership.
- **Runtime as source of truth, with the store as a projection** (keep
  `Lab` and `Machine` as owners and have the store mirror them through
  `onChange`). The changes would be smaller. But the policy stays in
  mutable classes that need workers to test, and the mirror is a second
  copy. The prototype's allocation rules are also wrong for the spec, so
  they'd be rewritten anyway. The shallow `onChange` interface hides
  nothing.
- **Frames through the reducer, with structural sharing (persistent
  vectors).** This gives one mechanism. But it's still an allocation and a
  notification per frame, and it needs a dependency for the persistent
  vector. The ring plus the match index is simpler and asymptotically
  better for every reader.
- **Shadow DOM with adopted sheets.** This matches the handoff's wording.
  It loses on the ARIA IDREF limitation and the WTerm risks described
  above. We'd revisit it if reference-target ships everywhere.
- **Agent tools with their own input parsers** instead of building a bar
  line. That means two parsers and two validators, a separate formatter for
  `recent`, and sentences that drift. Building the line also gets the log
  line for free.
- **Exec through the side channel (`vm.exec`)** with the output echoed into
  the screen. That gives exact exit codes, but the command runs outside the
  session's shell (wrong cwd and env), and it corrupts the interactive
  prompt's display. The handoff decided on typed lines, and OSC 133 keeps
  that honest.

## Open questions and risks

1. **Exit codes and the console.** Can guest setup make the *console's*
   already-running login shell emit OSC 133? Options: the worker re-execs
   the console shell after setup, or the console's getty starts after
   setup. Shells opened with `pty-open` start after setup and are fine. If
   neither works, should bar and agent `exec` default to a dedicated `sh`
   session per machine?
2. **Boot timeout.** Is 120 s from spawn right? Should it start at worker
   boot instead, so a cold image fetch doesn't count? What failure
   sentences can unkernel report?
3. **Capture bounds.** Are 10,000 entries and 16 MiB right? Should `clear`
   keep the counters? (This design says yes: the counters are the switch's.)
4. **WTerm in the garage.** Does WTerm tolerate being moved between parents,
   and does it measure correctly while `inert` and off-screen? This needs a
   spike in step 1. The fallback is one garage slot per pane-sized box.
5. **oxlint type-aware on TS 7.0.** Is tsgolint current with the installed
   tsgo? If not, do we accept syntactic lint only until it is?
6. **`boot` verb.** Is a bar verb for "Boot again" acceptable, and should
   agents get it?
7. **Persistence.** State is plain serialisable data, so persisting
   policies, history and pane order is a selector plus a `localStorage`
   effect. Should version 1 persist anything?
8. **Ctrl+/ off macOS** still needs per-browser testing (handoff open
   question).

## Next implementation step

Write `src/model/` (state, events, effects, the lifecycle table,
allocation, panes, tiling) and its unit tests before any element exists, then
reshape `LabSwitch` (numbered ports, flushed retention, `unknownDst`) with
its tests.

## Build order (mapped to the handoff's 10 steps)

Each step leaves the app working and ends in a named verification.

| # | Build | Verify |
| --- | --- | --- |
| 1 | Add `lit`, `@lit/context`, oxlint, oxfmt and Playwright. Write tokens.css, base.css and self-hosted fonts. `<unlab-app>` with six empty regions; prototype terminals mounted through a first `screens.ts`, including the garage-move spike (Open question 4). `npm run check` with format, lint, tsc and check-imports. | `check` is green. A Playwright smoke test shows six regions at their sizes (40/232/26 px, dock 3:2). A prototype machine boots and takes keys in a terminal moved through the garage twice. |
| 2 | `model/` and `createStore`. Reshape LabSwitch; retire `Lab` and `Session`; write `Vm` and the engine. Grammar core and `defineVerb`, then `spawn`, `rm`, `link`, `focus`, `boot`. Existing buttons call `run`. | Model unit suite: the lifecycle table exhaustively, plus allocation. The Node kernel test passes on the reshaped switch. E2E `spawn-link-rm.spec`: spawn 2, cut and reconnect node1, remove node2 (approval from a test hook until the bar exists). |
| 3 | `<unlab-machine-row>` and `<unlab-machine-details>` in all four phases: the 10 Hz boot counter, the failed error block, Boot again and Remove. | Fixtures `row-{booting,ready,failed,removing}×{up,cut,unplugged}` match the States artboard; axe is clean. E2E with a 2 s timeout override shows `did not boot`, and boot again recovers. |
| 4 | Panes in model; `<unlab-pane-area>` and `<unlab-pane>`; session tabs and `sh`; the parked strip; maximise and restore; double-click. | fast-check pane properties hold; the tiling table test covers 1-6 panes; fixtures match the Tiling artboard at 1600×900 and 900×700. E2E: 3 shells, park one, maximise, restore exactly, exit `sh1` and the tab to its left takes over. |
| 5 | The capture log and filter compiler; `<unlab-switch>`, `<unlab-port>` and the dock `<unlab-capture>` over the tap. | The match index agrees with a brute-force oracle on 50,000 random frames. 20,000 frames ingest in a tight loop in under 50 ms, with one notification per scheduled frame. E2E: `ping -f` for 2 s keeps long tasks under 50 ms (PerformanceObserver); a cut shows the `port N link down` row and the flood annotations. |
| 6 | Bar model and element: combobox, completion, preview, errors with carets and fix, confirm, history, `recent`, ⌘K or Ctrl+/, 1-8. | The bar-model suite replays each CmdOpen, CmdComplete, CmdError and CmdConfirm frame as a key sequence; screenshots match those artboards. E2E: type `link dwon node1`, Tab takes the fix, Enter cuts the link. |
| 7 | Shell tracker, guest prompt snippet, `ExecPort.inject`, line marks and overlay, per-machine report blocks, busy refusal. | Tracker unit tests with OSC 133 split across chunks. E2E: `exec all -- false` shows `exit 1` in `--down` per machine, with a grey rule over exactly the command rows; exec while `top` runs shows the skip sentence. |
| 8 | `<unlab-mac-table>` with flushed rows struck through; virtualised list; selection; `<unlab-frame-detail>` with the hued hex dump; `9 of 191 frames`; Save .pcap. | pcap bytes match a golden file. Fixtures match the Wire artboard. E2E: cut a cable and see the flushed row; reconnect and it relearns; the saved .pcap matches the buffer size. |
| 9 | Detection, the tool table, policies, approvals, pause, the agent panel, the blue rule and legend, the status segment. | Agent unit tests (ask then allow, deny, abort, off, pause) with a fake ModelContext. E2E with an `addInitScript` fake: the agent removes a machine through an approval, `recent` shows `rm node1` with a blue rule, and the pane shows the agent legend. |
| 10 | The Start view (derived from an empty rail) and `<unlab-spawn-form>`, which shows its command equivalent through `spawn.format(args)`, its preview through `spawn.preview`, and the not-enough-ports state. | Fixtures match the Start and Spawn artboards. E2E: first load, the form, boot 3, and the body returns to the lab with three booting panes. `check:all` is green. |
