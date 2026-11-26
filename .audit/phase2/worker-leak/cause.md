# A machine's worker that outlives its power-off

A machine that was powered off sometimes kept its worker, and the memory with it, until the page was closed or reloaded. `e2e/power.spec.ts` (reboot and poweroff typed in a guest) failed for it in 11 of 61 CI runs, at `expect.poll(() => workers(page)).toBe(0)`.

## What is left

A machine with two CPUs, the default, has two threads: its worker, and a worker of that worker which unkernel starts for the second CPU (`unkernel-cpu1`). After a leak both are still there (`results/first-runs.txt`). The page had done all it does: it received `released` and called `terminate()` on the worker in the same millisecond.

Neither thread runs or waits in the guest. Both sleep in their message loops, as an idle worker does. Their stacks, read from `/proc` without symbols by `browser.mjs`, are the stacks of the two threads that the page below leaves, word for word, and not the stack of a thread asleep in `Atomics.wait`.

## The order that loses them

`chromium/` is a page with no part of unLAB in it. Worker A has a worker B. A calls `B.terminate()`, tells the page, and the page calls `A.terminate()`. `results/chromium.txt` has 20 rounds of each case, in Chromium 155.0.8059.79:

| B | Who ends B | A after it told the page | Rounds that left both threads |
| --- | --- | --- | --- |
| idle | A | busy 50 ms | 20 of 20 |
| idle | A | not busy | 0 of 20 |
| idle | A | busy 50 ms, and the page waits 200 ms | 0 of 20 |
| idle | only the page, by ending A | busy 50 ms or 300 ms | 0 of 40 |
| asleep in `Atomics.wait`, or spinning | A or the page | busy 50 ms or 300 ms | 0 of 80 |

So both threads stay when three things meet. A worker ends a worker of its own. That one ends promptly. And the first worker is itself ended while it is too busy to hear of it. This much is measured. What follows is inferred from it, since Chromium's source was not read: the news that B has gone is queued for A's scope, A's own end tears that scope down with the news still queued, and A then waits for a child that has already gone.

A thread that sleeps in the kernel cannot end promptly. Chromium ends it by force two seconds later, long after A's scope has gone, and that order is not lost. It is why most power-offs take two seconds to give their memory back, and why they never leaked.

## How a power-off meets it

unkernel ends its CPU workers when the kernel exits (`this.exited.then(() => { for (const cpu of this.secondaries) cpu.terminate() })`). The lab's worker then saves the disks and posts `released`, and the page ends it at once. The second CPU's thread ended promptly in 5 of the 8 power-offs before the leak in the first of `results/first-runs.txt`, and then the outcome depends on whether the lab's worker is busy for the next few milliseconds.

- As it was, 4 of 309 power-offs left a worker: `results/first-runs.txt` and `results/before.txt`.
- With the lab's worker held busy for 50 ms after `released` (`BUSY_MS=50`), 6 of 48 did: `results/before-busy.txt`.

## The fix

`src/runtime/vm-worker.ts` makes `Worker.prototype.terminate` do nothing in a machine's worker. The kernel's CPU workers then end only with the worker that started them, which is the row of the table that never leaves a thread. The page ends that worker on every path, so nothing waits for them.

A second CPU that still ran guest code when its kernel was stopped, and not shut down, now runs until the page ends the worker: 250 ms for a machine that is removed, and the time it takes to save the disks for one that would not shut down. It cannot write to a disk: unkernel's CPU worker throws on every call to the host but the clock, the console, the JIT and a task switch, so only the first CPU's thread serves the disks.

- With the fix and the worker held busy, 0 of 88: `results/after-busy.txt`.
- With the fix alone, 0 of 196: `results/after.txt`.
- `e2e/power.spec.ts`, no worker is left by machines that power off while their workers are busy: 24 power-offs with the worker held busy. Red in 12 runs of 12 before the fix, and green in 5 of 5 after.
- All of `e2e/power.spec.ts` ten times in a row, 120 tests: `results/power-spec-x10.txt`.

## Not done

Chromium was not told, and neither was unkernel. `chromium/` is ready to attach to a report.
