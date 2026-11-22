# Spike: busybox drops input that shares a read with a cursor-position reply

Run from the repo root: `node .audit/spikes/cursor-reply-input-loss.mjs`.

Result, 2026-11-22, alpine (busybox ash), a fresh pty shell, `echo x-$((40+2))` typed:

| What reached the shell | Outcome |
| --- | --- |
| no reply ever, keys at +0 ms (separate spike) | ran |
| reply, then keys in the same millisecond | lost `echo a-$((`: ran `40+2))`, syntax error |
| reply and keys in one write | lost the same ten bytes |
| keys, reply 100 ms later | ran |
| reply, keys 50 ms later | ran |
| reply, keys 200 ms later | ran |

busybox asks `ESC[6n` at the end of every prompt and reads keys sixteen bytes at a time; the six-byte
reply plus the ten bytes after it fill one read, and the ten are discarded. Both the new-shell key drop
and the exec "settle" heuristic were this. Fix: `src/runtime/prompt-query.ts` removes the query that
directly follows the prompt's OSC 133;B mark, so the terminal never answers it. e2e/panes.spec.ts types
into a fresh shell at once: 3 of 3 fail without the filter, 5 of 5 pass with it.
