# Spike: frame delivery, its clock, and the language of the switch

Throwaway code and raw output are under `frames/`. Product code is unchanged. Observed on 2026-11-25 in Chromium
155.0.8059.79 and Node 24.21.0, unkernel 0.2.0-261124-c08e977, 16 threads, load below 1.3 before each run, one
measurement at a time. Brackets are the range of n runs, and the number before them the median. Sides alternate.

Run, with `SPIKE_OUT` any empty directory:

    nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#zig --command sh zig/build.sh ReleaseFast
    npx vite build -c vite.spike.config.ts
    node --expose-gc node-storm.ts; node stats.ts; node zig/check.ts; node bench-drive.ts 7
    node lab-drive.ts normal 5; ... storm 5; ... conditions 5; ... profile 2; ... ui 3; ... loss 5
    node clock-drive.ts headed 30 60 130; node hidden-drive.ts headed [long]; node playwright-hidden.ts

Headed runs used Xvfb, so the tab is a real one in a real window.

## Decision

1. **A cable is a queue in each direction, and a switch stays synchronous.** A cable's end is an ordinary
   `SwitchPort` whose `deliver` queues. A machine's cable with no conditions keeps today's direct call.
2. **Each direction has a bounded queue ordered by when its frames are due.** Delay, rate, reordering and the storm's
   pace only choose a due time. Loss, MTU and a full queue drop and count. A lab-wide FIFO is rejected below.
3. **One scheduler serves the directions round-robin**, for at most 4 ms, then yields a task: `MessageChannel` in a
   browser, `setImmediate` in Node. It sleeps until the earliest due time.
4. **A frame carries, beside its bytes, the set of switches it has been to.** One that comes back to a switch is
   looped, exactly and without a threshold. Eight switches are eight bits. It is lab metadata and never on the wire.
5. **Looped frames are paced, at 1,000 a second in each direction, and at most 64 wait.** Nothing else is slowed. The
   switch that a frame came back to is storming, and its looped frames are the rate to show.
6. **A switch forgets its table when its storm ends** (100 ms with no looped frame). Without it, pings do not recover.
7. **The switch stays on the page's thread. Its timers move to a worker** that does nothing else (`alarm-worker.ts`).
8. **Wait at most 30 ms per timer, rounded up to a whole millisecond**, and compute due times from due times, not from
   when a timer woke.
9. **Randomness is an injected `() => number` for each direction**, drawn once for each frame and for each condition.
   Seeded in tests, from `crypto` in the app.
10. **TypeScript**, behind a narrow core interface.

## 1. Where the switch runs today

On the page's main thread. `runtime.ts:30` makes the one `LabSwitch`. A guest's frame is copied out of wasm
(`nic.ts:74`), posted from its worker with its buffer transferred (`vm-worker.ts:227`), received on the page
(`vm.ts:159`), matched to its port and given to the switch (`engine.ts:303`). The switch copies it for the tap
(`switch.ts:132`), calls each port inside the same call (`switch.ts:141,144,187`), the engine calls the machine
(`engine.ts:525`), which copies it again and posts it to the other worker (`vm.ts:244-248`), where it enters the kernel
(`nic.ts:79`). The tap writes to the capture log on the same thread (`engine.ts:174`). Guests never share a thread.

Two unbounded queues matter: a worker's messages, and `netRx`, an array in unkernel that eth0's frames wait in. A TAP
NIC is bounded (`tap.ts:14,107`).

Frame sizes: in every TCP transfer between single-NIC machines, the largest frame was 1514 bytes.

**Recursion, now observed.** Three cabled `LabSwitch`es and one broadcast: the call recursed 2,500 cables deep and
overflowed the stack. `switch.ts:188` swallowed the `RangeError`, so `receive` returned, the storm ended by itself,
and two frames were counted as dropped on two ports. A loop would look like a harmless broadcast.

## 2. The queue

- **A.** One lab-wide FIFO, at most 4,096 frames, and one heap for delayed frames.
- **B.** A queue for each direction, at most 256 frames, round-robin, and a heap of directions by their first due time.

Storms between real guests, n=5, 10 s each, one injected broadcast. The pair's ping is between two guests on two
switches that share nothing with the storm (`results/storm3-summary.txt`, `storm4-summary.txt`).

| Design, on the page | Frames/s | Main thread | Worst timer gap, ms | Unrelated pair's ping | Ping after the cut |
| --- | --- | --- | --- | --- | --- |
| A, triangle | 746k [742-803k] | 1.00 core | 8 [7-9] | | 3/3 |
| B, triangle | 346k [342-350k] | 0.97 | 101 [26-127] | | 3/3 |
| **B paced, triangle** | 3.9k [3.1-4.1k] | 0.13 | 1 [1-2] | | 3/3 |
| A, full mesh of four | 558k [532-567k] | 0.95 | 50 [19-227] | **0/20** | 3/3 |
| B, full mesh of four | 532k [525-534k] | 0.96 | 209 [36-226] | 20/20, 7.6 ms | 3/3 |
| **B paced, full mesh** | 12.0k [11.99-12.01k] | 0.15 | 5 [1-6] | 20/20, 0.88 ms | 3/3 |

- **A shares its bound.** A storm fills it, and every other switch in the lab loses its frames. That rejects it.
- **The main thread keeps running tasks in all of them.** Worst gap 247 ms, 59 to 60 paints/s, a page evaluation
  within 11 ms, an `echo` in a guest's shell within 49 ms.
- **The cut.** The last looped frame was 13 ms or less after it in every run. The pings' check includes 0.5 s of
  waiting and ended within 1.0 s. In the mesh, the check cut all six cables: one cut leaves other loops.
- **Memory, over 60 s, one run each, capture swept once a second as the engine does.** Paced triangle 517 to 534-656
  MB and level. Paced mesh 591 to 670-753 and level. Unpaced mesh 571 to 1,534-2,116 with bounded NICs, and up to
  2,951 with one guest unable to answer for 2 s without them.
- **The capture log can kill the page.** With `sweep` not running, the unpaced mesh crashed the page within 60 s:
  `log.ts:303` keeps every ARP request until a sweep. A hidden tab sweeps once a minute after five minutes, so a storm
  of ARP should be bounded there too. The memory columns of `storm3` were taken without the sweep and overstate it.
- **Why pace and not a storm limit by rate.** A limit on broadcasts alone did not work: addresses flap during a storm,
  so unicast frames loop too, at 880k/s. The set of visited switches catches both and never touches other traffic.
- **What limits it.** Unpaced, the thread that runs the switch, at 0.95 to 1.0 core. Paced, the pace.
- **Forgetting the table.** Without it, 0 of 3 pings were answered in the 2 s after the cut in several runs: each
  switch remembered machines behind the wrong cable (`MACS` in the output). Flushing at the cut is too early, because
  frames already in queues teach the wrong port again.
- **Node.** `MessagePort` messages that beget messages starve Node's timers: a 2 s storm held every timer for 4 s.
  With `setImmediate` the worst gap was 14 ms.

### The normal path

TCP between two real guests, 128 MiB, and 300 pings, n=5 (`results/normal3.txt`). The receiver discards what it reads.
An earlier set had the receiver count bytes with `wc`, and measured that guest (335 Mbit/s for every design). It is
not used.

| | One switch: ping p50, ms | TCP, Mbit/s | Across a cable: ping p50 | TCP |
| --- | --- | --- | --- | --- |
| Today's code | 0.99 [0.96-1.02] | 839 [822-845] | 1.00 [0.98-1.04] | 716 [708-727], recursing |
| B on the page | 1.02 [0.72-1.03] | 832 [801-847] | 1.01 [0.99-1.05] | 665 [653-681] |
| B in a worker | 1.06 [1.02-1.08] | 728 [719-748] | 1.09 [1.08-1.11] | 639 [631-654] |
| Lean TypeScript core, page | 1.00 [0.97-1.01] | 852 [835-891] | 1.03 [1.02-1.07] | 719 [709-732] |
| Zig core, page | 0.99 [0.95-1.02] | 855 [830-892] | 1.03 [0.98-1.05] | 743 [718-765] |

- On one switch B is not measurably slower. Across a cable it is 7% slower than today's recursion, and the lean core,
  which does the same work with numbers instead of text for addresses, gets that back.
- **What limits TCP.** The thread the switch is on, at 0.95 core, with guests at 0.94 and 0.76. Of the page's
  time in today's code: the browser's own message handling 33%, `postMessage` 14%, reading the message and its handler
  11%, the copy for the port 9%, `receive` with the tap's copy 12%, `performance.now` 5%, garbage collection 3 to 4%,
  addresses as text and learning 4%.
- In the shipped app, with everything drawn, n=4: 571 to 618 Mbit/s, main thread 0.89 to 0.97 core.

### One design serves the conditions

On real guests, n=5, clock worker (`results/cond2.txt`):

| Condition on a machine's cable | Observed |
| --- | --- |
| 5, 100, 1000 ms delay: what a ping takes beyond base and twice the delay | 2.1 [1.9-2.3], 3.0 [2.9-3.3], 3.3 [3.1-3.9] ms |
| 25% of frames skip a 20 ms delay, 200 pings | 62 [54-65] replies out of order |
| MTU 1000 | 0 of 2 at 1200 bytes, 2 of 2 at 900 |
| 1 and 10 Mbit/s, TCP payload | 0.96 [0.96-0.96], 9.57 [9.57-9.57] Mbit/s |
| 1 Mbit/s, 64 KiB queue, 1 MiB sent | 11 [10-11] frames dropped |

The payload is 95.6% of the rate because 66 of each 1514 bytes are headers.

A due time also orders a queue, so frames sent as conditions are cleared would overtake those still waiting. The build
must decide that: B's answer should be to drop what waits or to keep the order until it is empty.

## 3. The clock

Timer lateness, in ms, no debugger attached, a tab hidden by opening another in the same window. The page reported
`document.visibilityState` as `hidden` in each hidden row, and the change is in its log. Two runs, which agree:
`results/clock-long-1.txt` and `-2.txt`. "Armed by a message" is a timer set when a frame arrives. "Chained" is one
set by another timer.

| Page's thread | 5 ms | 100 ms | 1 s |
| --- | --- | --- | --- |
| Visible, armed by a message, p50 / max | 0.1 / 1.4 | 3 to 5 / 9 | 4 to 6 / 8 |
| Hidden, first minutes, armed by a message | 995 / 997 | 900 / 902 | 1000 / 1001, or on time |
| Hidden, first minutes, chained | 995 / 997 | 900 / 902 | 1000 / 1001, or on time |
| Hidden past five minutes, armed by a message | 995 / 998 | 900 / 903 | 1000 / 1001, or on time |
| **Hidden past five minutes, chained** | **59,995** | **59,900** | **59,000** |

| Worker | 5 ms | 100 ms | 1 s |
| --- | --- | --- | --- |
| Visible | 0.07 / 2.7 | 7 / 9 | 7 / 8 |
| Hidden, first minutes | 0.07 / 3.2 | 7 / 9 | 7 / 9 |
| Hidden past five minutes | 0.10 / 45 | 7 / 13 | 7 / 9 |

- The 1 s throttle and the intensive one, a wake a minute, were both seen on the page and neither in a worker.
- So page timers would make a 5 ms or 100 ms delay up to 1 s, and spanning tree's 2 s hellos one a minute.
- Messages are not throttled: a round trip to a worker with a 10 ms pause took at most 16 ms hidden, over 24,000.
- Chromium lets a timer longer than about 32 ms be 8 ms late in either thread, and ones of 30 ms or less were within
  0.7 ms (p95). Waiting in steps of at most 30 ms avoids it.
- A fraction is cut off: a 4.3 ms wait wakes early, re-arms for nothing, and is then held to 4 ms by nesting. It added
  8 ms to a ping with two 5 ms delays. Rounding up made that 1.5 ms.

Between real guests, headed and hidden, 3 runs, and 2 more past five minutes (`results/hidden1.txt`, `hidden2.txt`):

| Hidden tab | 5 ms: ping | 100 ms: ping | 1000 ms: ping | 1 Mbit/s: TCP |
| --- | --- | --- | --- | --- |
| Page timers | 402 to 405 ms | 403 to 406, 1 in 20 lost | 2,436 to 2,480 | 0.26 to 0.36 |
| Clock worker, switch on the page | 13.1 to 13.2 | 204.1 to 204.5 | 2,004 to 2,005 | 0.96 |
| Switch in a worker | 12.7 to 12.8 | 203.4 to 204.2 | 2,003 to 2,004 | 0.96 |

Past five minutes, the same within 1 ms for the two workers. The page timers' numbers are the ping's own 200 ms rhythm:
each frame that arrives wakes the queue, so a quieter link would be as late as the first table says.

**Playwright cannot show this.** A page it drives stays `visible` behind another, with its throttling arguments removed
and with focus emulation off (`results/playwright-hidden.txt`). Headless Chromium does hide a tab, with
`PUT /json/new` on the debugging port. A test of a hidden tab has to start Chromium itself.

## 4. A worker for the switch, or for its timers

**Only the timers.** A worker of 16 lines that answers `{id, ms}` with `id` gives, hidden, what a whole switch in a
worker gives. It costs 0.3 ms more lateness a crossing than the page's own timers when visible, and no call becomes asynchronous.

The whole switch in a worker costs 13% of TCP (728 against 839), 0.06 ms of ping, and work: each machine needs a
`MessagePort` to it, `RuntimeReads` becomes a copy that is sent, link, VLAN and cable commands become messages, and the
capture's frames and times come in batches. It buys the page its thread back. During a transfer at full speed the page
was 0.95 core and still drew 60 times a second with a worst gap of 14 ms, against 0.11 core and 7 ms (n=3). Paced storms
take 0.15 core. That is not yet a problem to pay for.

Change the answer if, with 16 machines and the app drawn, the page misses frames while machines transfer. Keep the
core free of the DOM so that it can move.

## 5. Randomness

- **20% loss over 1,000 frames, within three points: a right cable fails 1.58% of the time**, one run in 63 (exact
  binomial, `stats.ts`; 1.56% of 200,000 simulated runs). Both directions at once, 36%, fail 4.4%. And it is weak: a
  cable that loses 15% passes 4.4% of the time, and 25% passes 7.6%.
- **Two tests show the box honestly.**
  1. On real kernels, 1,000 frames and a seed. Each direction draws once for each frame, so the frames that are lost
     depend only on their number on that direction, not on the guests' timing, and the result is the same every run.
     Use the cable's counters, checked against the receiver's `rx_packets`.
  2. On real kernels with no seed, 10,000 frames: 8.6e-14. A cable that loses 25% passes 1.7e-6 of the time. UDP sends
     7,400 frames in 0.5 to 2.5 s, and five runs gave 19.7 to 20.7%. Pings would take a minute.
- `sfc32` with a seed fails as often as it should (1.54% of 200,000 seeds), so a seed must not be shopped for. Write
  one down before seeing its result and leave it.
- The draws of loss and of reordering must be separate streams, or switching one on changes the other's frames.

## 6. Zig or TypeScript

Zig 0.16.0, `wasm32-freestanding`, ReleaseFast. `zig/core.zig` (270 lines) and `lean.ts` (219) do the same: VLANs in
the key of the table, flood, per-direction queues, marks, pace, delay and loss. `zig-core.ts` (35) is the boundary.
`zig/check.ts` fed both 200 random runs, and they handed out the same 369,332 events in the same order. Loss was not
part of that comparison.

The core alone in Chromium, n=7 (`results/bench.txt`). "With copies" copies each frame for the port and for the tap, as
the product must, and for Zig into its memory as well.

| ns a frame | 64 B, one switch | 1514 B, one switch | 64 B, two switches | 1514 B, two switches |
| --- | --- | --- | --- | --- |
| Today's switch and B, with copies | 753 [733-843] | 1551 [1483-1569] | 2161 [2122-2220] | 3449 [3285-3491] |
| Lean TypeScript, with copies | 343 [330-361] | 1161 [1130-1246] | 549 [517-573] | 1701 [1675-1789] |
| Zig, with copies | 393 [380-423] | 1196 [1151-1224] | 488 [479-494] | 1708 [1652-1753] |
| Lean TypeScript, no copies out | 275 [270-305] | 281 [266-334] | 422 [390-450] | 424 [400-463] |
| Zig, no copies out | 304 [290-312] | 310 [301-353] | 315 [306-353] | 337 [325-371] |

A storm, unpaced, frames/s: at 64 bytes 1.01M, 7.75M and **9.04M** [8.94-9.15M]. At 1514 bytes 0.55M, 1.17M [1.12-1.18M]
and 1.18M [1.12-1.19M]. The worst gap was 17 ms in all. The worst thousand frames took 2.1 to 2.8 ms in both new
cores. Garbage collection's own pauses were not traced.

- **The gain is in the algorithm.** Numbers for addresses cut today's cost by 25% (1514 bytes, one switch, where
  copies are most of it) to 75% (64 bytes across a cable). Against lean TypeScript, with no copies out, Zig is 10% slower
  on one switch, which pays for the copy in and the calls, and 20 to 25% faster across a cable. With copies at 1514 bytes
  they are equal.
- **Real guests do not notice.** See the normal path: 852 and 855 on one switch, with ranges that coincide. Across a cable
  719 [709-732] and 743 [718-765], which overlap. In a worker, Zig on one switch had 744, against 728 for B.
- **Amdahl.** In a full-speed transfer across a cable, the lean core's own functions (`#forward`, `mac`,
  `drain` and its queues) are about 4% of the page's thread, and 8 to 10% with its entry and loop. A core that took no
  time could make the transfer at most 1.11 times as fast, and by 1.04 if the loop stays in TypeScript, as it does here.
  For a ping it is about 2 µs of 1 ms. The profile put Zig's code at 0.3% and its way in, with the copy, at 2.5%. The
  copies out, the messages and the browser's handling of them are the rest, and a wasm core changes none of them.

| | TypeScript | Zig |
| --- | --- | --- |
| Crosses the boundary | Nothing. Frames are the arrays that arrived | Each frame in, each delivery and tap out, every read of the table as numbers, every setting |
| Who owns a frame | The garbage collector. A flood shares one | A slab of 8,192 slots with a count. A leaked count is a leaked slot. A full slab is one more way to drop |
| Bounds | Each direction's queue | That, the slab, and a table of 1,024 addresses: all fixed, or an allocator |
| Unit and property tests | As today | Work too: the module loads synchronously in Node. A failing run shrinks to numbers, and a trap has no line without debug info |
| Debugging | The page's own tools | `wasm-function[6]` in a profile. Source needs DWARF and an extension |
| Types shared with the reducer and capture (`PortNo`, `Flood`, `TapEvent`, plans) | One definition | Stated twice, with nothing checking that they agree |
| Size | In the bundle | 219 kB, 2.9 kB compressed (ReleaseSmall 217 kB and 2.4) |
| CI and contributors | Nothing | Below |

The helper's pattern (a script, the built bytes and the source's hash, nobody needs Zig) fits a file that rarely
changes. The switch would change in most phase 2 stories: each would commit a new binary, and two branches' binaries
cannot be merged. A Zig core should be built in CI, which needs Zig 0.16 pinned there and for whoever touches it.

`SharedArrayBuffer` is not needed, on the page or in a worker: messages carry the frames, and the module's memory is its
own. A ring without copies between workers would need it. GitHub Pages cannot send the headers, so the app registers
`public/isolation.js`, which adds them, and reloads once (`main.ts:212-227`). When that fails it warns and goes on, so
nothing may depend on it.

**Recommendation: TypeScript, behind the interface `lean.ts` uses** (`receive`, `drain`, `next`, settings in, `out` and
`tap` out, time passed in, no DOM). Take the lean core's numeric keys. It is what the tests and any later core would
meet. What would change it: a profile of the app with 16 machines where the core itself, copies and messages left out,
is above 20% of the thread it is on.

## Boxes to change

- **5.1, loss.** "Within three points over 1,000" cannot be a steady test of an unseeded cable (1.58%). See 5. It must
  also say that the share is of frames in one direction.
- **2.4, pings work again.** Reachable only if switches forget their tables after a storm, as no plain switch does.
- **2.4, cutting one cable.** True of a single loop. With more loops, one cut leaves a storm.
- **2.4, crashes.** Also needs a bound on the capture's open ARP requests.
- **5.1 and 7.1 in a hidden tab.** Reachable with the clock worker, not with page timers, and not testable by
  Playwright's own pages.

## Not verified

- Sixteen machines, eight switches, or the app's whole page during a storm. The harness draws capture rows but not the
  app. The app was measured only as shipped, for TCP.
- The final pace. 1,000 a second was the only one tried. Eight switches in a full mesh copy a broadcast up to
  13,699 times before any copy is looped (computed). Only the queues' bounds hold that, and it was not run.
- A frozen or discarded tab, memory saver and battery saver. Either design would stop.
- Other browsers, macOS and Windows, battery power, and the CI runner.
- A loop through a guest that bridges two NICs. Its frames are new each time, so they are not marked. The budget and
  the queues bound it.
- VLAN tags, RSTP, and conditions on a cable inside a loop.
- Guest CPU time. Which guest's thread was the busy one in a transfer was not identified.
- Garbage collection pauses by trace, and the effect of wasm memory growth. The module's memory is fixed.
