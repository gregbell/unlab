import { readFileSync } from "node:fs";
import { createKernel } from "unkernel/node";
export const HELPER = readFileSync(new URL("./unlab-nic", import.meta.url));
const mac = s => Uint8Array.from(s.split(":").map(x => parseInt(x, 16)));
// one kernel per thread, so this test uses worker threads
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
if (isMainThread) {
  const D = process.argv[2];
  const mk = (name, nics, plain) => new Promise(res => {
    const w = new Worker(new URL(import.meta.url), { workerData: { D, name, nics, plain } });
    const m = { w, name, pend: new Map(), id: 0, ex(cmd) { const id = ++m.id; return new Promise(r => { m.pend.set(id, r); w.postMessage({ id, cmd }); }); } };
    w.on("message", x => { if (x.ready) res(m); else if (x.f) wire(m, x.nic, x.f); else if (x.id) m.pend.get(x.id)(x); else if (x.err) console.log(name, x.err); });
    w.on("error", e => console.log(name, e));
  });
  let links = new Map(); let biggest = 0;
  const wire = (m, nic, f) => { biggest = Math.max(biggest, f.length); const peer = links.get(m.name + nic); if (peer) peer[0].w.postMessage({ nic: peer[1], f }); };
  const plain = process.argv[3] === "plain";
  const [a, r, b] = await Promise.all([mk("a", 1, plain), mk("r", 2, plain), mk("b", 1, plain)]);
  links.set("a0", [r, 0]); links.set("r0", [a, 0]); links.set("r1", [b, 0]); links.set("b0", [r, 1]);
  const run = async (m, c) => { const x = await m.ex(c); console.log(`[${m.name}] ${c}\n   exit ${x.code} ${(x.out || "").trim().split("\n").slice(-3).join(" | ")}`); return x; };
  await run(r, "ip addr add 10.1.0.1/24 dev eth0; ip addr add 10.2.0.1/24 dev eth1; ip link set eth1 up; sysctl -w net.ipv4.ip_forward=1; ip -br a 2>/dev/null || ip a | grep -E 'eth|inet'");
  await run(a, "ip addr add 10.1.0.2/24 dev eth0; ip route add default via 10.1.0.1");
  await run(b, "ip addr add 10.2.0.2/24 dev eth0; ip route add default via 10.2.0.1");
  await run(a, "ping -c 3 -W 2 10.1.0.1 | tail -2"); await run(b, "ping -c3 -W2 10.2.0.1 | tail -2");
  await run(a, "ping -c 3 -W 2 10.2.0.2 | tail -2");
  b.ex("head -c 8000000 /dev/zero | nc -l -p 9000 -w 20");
  await new Promise(r => setTimeout(r, 800));
  const t = Date.now(); await run(a, "timeout 40 nc -w 15 10.2.0.2 9000 | wc -c"); console.log("TCP a<-b via router, ms", Date.now() - t, "biggest frame", biggest);
  r.ex("head -c 2000000 /dev/zero | nc -l -p 9001 -w 20"); await new Promise(r => setTimeout(r, 800));
  await run(b, "timeout 40 nc -w 15 10.2.0.1 9001 | wc -c");
  b.ex("head -c 2000000 /dev/zero | nc -l -p 9002 -w 20"); await new Promise(r => setTimeout(r, 800));
  await run(r, "timeout 40 nc -w 15 10.2.0.2 9002 | wc -c");
  process.exit(0);
} else {
  const { D, name, nics, plain } = workerData;
  let k; const net = { mac: mac(`52:54:00:88:00:${name === "a" ? "0b" : name === "r" ? "0c" : "0d"}`), attach(x) { k = x; }, send(f) { const c = f.slice(); parentPort.postMessage({ nic: 0, f: c }); } };
  const vm = await createKernel({ distro: D, net, memoryMiB: 256, log: () => {} });
  const root = (c, input) => vm.exec("/bin/sh", ["-c", c], { user: "root", input });
  const x = await root("cat > /run/unlab-nic && chmod 755 /run/unlab-nic && ip link set eth0 up", HELPER);
  if (plain) { const p = await root("/run/unlab-nic plain eth0"); if (p.exitCode) parentPort.postMessage({ err: p.stderr }); }
  const taps = {};
  for (let i = 1; i < nics; i++) {
    const p = await vm.spawn("/run/unlab-nic", ["tap", `eth${i}`, `52:54:00:88:0${i}:0c`], { pty: false, user: "root" });
    const wr = p.stdin.getWriter(); taps[i] = wr; let first;
    const ok = new Promise(r => { first = r; });
    (async () => { for await (const e of p.stderr) parentPort.postMessage({ err: Buffer.from(e).toString() }); })();
    (async () => { let buf = new Uint8Array(0); for await (const c of p.stdout) { const n = new Uint8Array(buf.length + c.length); n.set(buf); n.set(c, buf.length); buf = n; let at = 0; while (buf.length - at >= 2) { const len = buf[at] << 8 | buf[at + 1]; if (buf.length - at - 2 < len) break; if (!len) first(); else parentPort.postMessage({ nic: i, f: buf.slice(at + 2, at + 2 + len) }); at += 2 + len; } buf = buf.slice(at); } })();
    await ok;
  }
  parentPort.on("message", async m => { if (m.f) { if (m.nic === 0) k?.receiveFrame(m.f); else { const o = new Uint8Array(m.f.length + 2); o[0] = m.f.length >> 8; o[1] = m.f.length; o.set(m.f, 2); taps[m.nic].write(o); } } else { const r = await root(m.cmd); parentPort.postMessage({ id: m.id, code: r.exitCode, out: r.stdout + r.stderr }); } });
  parentPort.postMessage({ ready: true });
}
