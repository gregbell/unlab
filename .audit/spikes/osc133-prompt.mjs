const U = await import("file:///home/greg/src/unlab/node_modules/unkernel/dist/node.mjs");
const G = await import("file:///home/greg/src/unlab/src/lab/guest.ts");
const I = await import("file:///home/greg/src/unlab/src/lab/image.ts"); const buf = (await import("node:fs")).readFileSync(`public/distros/${process.argv[2]}.erofs`); const vm = await U.createKernel({ distro: new I.MemoryDisk(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)), memoryMiB: 256, consoleSize: { cols: 120, rows: 30 } });
let out = ""; vm.onOutput((b) => { out += Buffer.from(b).toString("latin1"); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = String.raw`PS1='\[\033]133;D;$?\007\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'`;
const script = [
  `printf '%s\\n' ${G.sh(PROMPT)} > /etc/profile.d/kw-unlab.sh`,
  `printf '\\r\\033[K' > /dev/hvc0`,
  `for p in /proc/[0-9]*; do case "$(head -c1 $p/cmdline 2>/dev/null)" in -) ;; *) continue;; esac && [ "$(readlink $p/fd/0)" = /dev/hvc0 ] && kill -HUP \${p#/proc/}; done; true`,
].join("\n");
const t0 = performance.now();
const r = await G.execAsRoot(vm, script);
console.log("setup exit", r.exitCode, JSON.stringify(String(r.stderr)), Math.round(performance.now() - t0), "ms");
let i = out.length; await wait(1500); console.log("--- after respawn\n" + JSON.stringify(out.slice(i)));
i = out.length; vm.write("false\n"); await wait(600); vm.write("echo hi\n"); await wait(600); console.log("--- commands\n" + JSON.stringify(out.slice(i)));
const pty = await vm.spawn(undefined, undefined, { pty: true, cols: 80, rows: 24, term: "xterm-256color" });
const rd = pty.output.getReader(); let pout = ""; (async () => { for (;;) { const { done, value } = await rd.read(); if (done) break; pout += Buffer.from(value).toString("latin1"); } })();
await wait(800); await pty.write("false\n"); await wait(600); console.log("--- pty shell\n" + JSON.stringify(pout));
process.exit(0);
