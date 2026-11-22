# Spike: OSC 133 prompt marks in the guest

Run from the repo root: `node .audit/spikes/osc133-prompt.mjs alpine` (or `debian`).

Result, 2026-11-22: VERIFIED on alpine (busybox ash) and debian (bash).

- Setup writes `/etc/profile.d/kw-unlab.sh` with
  `PS1='\[\033]133;D;$?\007\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'`.
  Login shells and the image's `ENV` file (`/usr/lib/kw/shrc`, which sources `kw-*.sh`) both pick it up.
- The console's login shell already started before setup, so setup prints `\r\033[K` to `/dev/hvc0`
  and sends SIGHUP to the login shell (cmdline starting with `-`) whose stdin is `/dev/hvc0`.
  init respawns `kwtty login`, and the new shell prints one fresh prompt with the marks.
- After `false`: `ESC]133;D;1 BEL ESC]133;A BEL <prompt> ESC]133;B BEL`. After `echo hi`: `D;0`.
- Shells opened with `vm.spawn(..., { pty: true })` get the same prompt.
- Setup cost: about 0.5 s on alpine, 0.8 s on debian.

Consequence: exec exit codes and busy-session detection come from a pure OSC 133 scanner over the
session's bytes. No sentinel is needed for the shipped images. 133;C is never emitted, so "running"
starts when a line is submitted (Enter while at a prompt) and ends at the next D.
