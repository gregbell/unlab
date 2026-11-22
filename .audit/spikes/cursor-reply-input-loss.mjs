const U = await import("file:///home/greg/src/unlab/node_modules/unkernel/dist/node.mjs");
const vm = await U.createKernel({ distro: await U.fetchDistro("alpine"), memoryMiB: 256 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CPR = "\x1b[1;5R";
async function trial(label, steps) {
  const pty = await vm.spawn(undefined, undefined, { pty: true, cols: 80, rows: 24, term: "xterm-256color" });
  let out = "";
  const rd = pty.output.getReader();
  (async () => { for (;;) { const { done, value } = await rd.read(); if (done) break; out += Buffer.from(value).toString("latin1"); } })();
  await wait(50);
  for (const [ms, data] of steps) { if (ms) await wait(ms); await pty.write(data); }
  await wait(1500);
  const ran = out.match(/(\S*)-42\r?\n/);
  console.log(`${label}: ${ran ? "RAN" : "LOST"}  echoed=${JSON.stringify((out.split("\x1b[6n")[1] ?? "").slice(0, 40))}`);
  void pty.kill();
}
const line = (l) => `echo ${l}-$((40+2))\n`;
await trial("reply then keys, separate writes 0ms", [[0, CPR], [0, line("a")]]);
await trial("reply+keys in one write", [[0, CPR + line("b")]]);
await trial("keys then reply 100ms later", [[0, line("c")], [100, CPR]]);
await trial("reply, keys 50ms later", [[0, CPR], [50, line("d")]]);
await trial("reply, keys 200ms later", [[0, CPR], [200, line("e")]]);
process.exit(0);
