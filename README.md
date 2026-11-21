# unlab

A Linux network lab that runs entirely in a browser tab. Every machine is a
real Linux kernel — the same [unkernel](https://github.com/pithings/unkernel)
build that unkernel.dev runs — and they are all wired to one virtual layer-2
switch, so you can ping, route, serve and break things between them.

```
ping node2
64 bytes from 10.88.0.12: seq=0 ttl=42 time=1.4 ms
```

That reply came out of a second Linux kernel, running in another thread, in
the same tab.

## What it actually is

| | |
|---|---|
| Machine | one unkernel kernel in its own Web Worker |
| Terminal | libghostty's VT engine on WebAssembly, through wterm |
| Network | a learning layer-2 switch on the page's main thread |
| Segment | `10.88.0.0/24`, one address per machine |
| Internet | optional per machine, over a NAT uplink |

Each machine gets a `NetDevice` — the kernel's own NIC interface, which deals
in raw Ethernet frames. Frames addressed to the lab subnet go to the switch,
which learns MAC addresses, floods what it has not learned yet, and delivers
the rest to one port. Nothing in between parses or rewrites them, so what the
guests do is real: ARP resolution, ICMP, UDP, TCP handshakes, retransmits,
`tcpdump`. Two kernels' network stacks talking to each other.

Anything *not* addressed to the lab goes instead to a `NetStack`, unkernel's
NAT gateway on `10.0.2.0/24`, which reaches the internet over a Wisp proxy.
That is what makes `apk add` work. A machine with the internet enabled ends
up with both addresses on `eth0`:

```
3: eth0  inet 10.0.2.15/24   scope global eth0    <- uplink, default route
3: eth0  inet 10.88.0.13/24  scope global eth0    <- the lab segment
```

### Terminals and tabs

Panes run on [libghostty](https://ghostty.org) — Ghostty's own VT engine
compiled to WebAssembly — driven by [wterm](https://wterm.dev), which is also
the terminal unkernel.dev uses. Escape sequences, graphemes, wide glyphs and
SGR behave as they do in Ghostty itself, and the DOM renderer keeps native
selection, clipboard, browser find and screen-reader support.

Every machine has a **console** (the kernel's own, which carries the boot log)
and as many **shells** as you open. A shell is a real pty in the guest, from
`vm.spawn()`, so `tty` says `/dev/pts/0` and `stty size` follows the pane.
That means several tabs can point at the same machine: watch `tcpdump` in one
and run `ping` in another. Inactive panes keep parsing output and only stop
painting, so nothing is missed while you are looking elsewhere.

### Why one worker per machine

A kernel owns its thread: while idle it blocks in `Atomics.wait`, and unkernel
runs one kernel per thread. So each machine gets its own Web Worker, and a
machine that is busy — compiling, looping, panicking — cannot stall another
machine or the page.

## Running it

```sh
npm install
node scripts/fetch-distros.ts alpine     # add `debian` for the 72 MB image too
npm run dev
```

Then open the printed URL. Two machines boot on their own; `Add` gives you
more.

```sh
npm run build && npm run preview   # production build
npm test                           # boots two machines in Node and pings between them
npm run typecheck
```

## The exact same builds

Nothing here is rebuilt or repacked.

* The kernel is `unkernel.wasm` from the pinned `unkernel` npm package, which
  is what the SDK ships and what the bundler emits as an asset.
* The root images are the `.erofs` assets from the GitHub release matching
  that package version — the same release unkernel.dev builds its own
  `/distros/` from. `scripts/fetch-distros.ts` reads the release's
  `distros.json`, downloads each image and checks its size and SHA-256
  against the index before writing it.

Pinning the package pins the images. `public/distros/distros.json` records
what was mirrored, down to the upstream build id:

```json
{ "name": "alpine", "image": "alpine-3.24.4-0efe379209f9a99a", "sha256": "6af841ca…" }
```

## Things to try

**Networking**

* `ping node2`, then pull node2's cable in the topology panel and watch the
  ARP retries pile up on the wire.
* `nc -l -p 9000` on one machine, `nc node1 9000` on another.
* `ip neigh show` — the ARP table, filled by frames that really crossed.
* Watch the wire panel while you work: the first frame to an unlearned
  address is flooded (marked `~`), the rest are delivered to one port.
* Give one machine two roles: `ip addr add 10.88.0.200/24 dev eth0`.

**Sysadmin**

* Enable the internet on a machine, then `sudo apk add tcpdump` and run
  `tcpdump -i eth0 -n` while another machine pings it.
* `sudo apk add python3` and serve a directory with
  `python3 -m http.server 80`, then `wget -qO- node1` from a neighbour.
* Break name resolution on purpose: edit `/etc/hosts` and see what still
  works by address.

## Limits

These are worth knowing before you chase a ghost:

* **IPv6 is dropped.** The uplink has no IPv6 and the switch discards it, so
  the lab is IPv4 only.
* **One NIC per machine.** unkernel gives a kernel a single network device,
  so routers between separate segments need address aliases rather than a
  second interface.
* **The uplink carries TCP, DNS and DHCP only** — no outbound ping to the
  internet, no arbitrary UDP. Traffic *inside* the lab has no such limit:
  that is the guests' own stacks over raw frames.
* **The internet path leaves your browser.** It goes through a public Wisp
  proxy (`wss://wisp.pi0.io`), unkernel's default. It is off by default and
  opt-in per machine.
* **Nothing is persisted.** Every machine starts from the read-only image
  with a fresh overlay; closing the tab discards the lot.

## Layout

```
src/lab/frames.ts    Ethernet/ARP/IPv4 parsing, and lab-vs-uplink classification
src/lab/switch.ts    the learning layer-2 switch, with counters and a tap
src/lab/nic.ts       the NetDevice each machine gets
src/lab/image.ts     one shared copy of a distro image; a read-only block device
src/lab/guest.ts     running things as root, and the setup each machine boots into
src/lab/lab.ts       addresses, names, /etc/hosts, the machine list
src/lab/machine.ts   a machine and its sessions: console, shells, counters
src/vm-worker.ts     one machine, alone in its thread
src/ui/terminal.ts   a pane: wterm on the libghostty WASM core
src/ui/sidebar.ts    the machines list and the selected machine's detail
src/ui/wire.ts       the packet list, switch stats and MAC table
src/ui/topology.ts   the lab drawn as it is wired
test/lab.test.ts     two machines in Node: ARP, ICMP and TCP across the switch
```

## The interface

The layout follows [Herdr](https://herdr.dev): machines where its spaces are,
the selected machine's detail where its agents are, tabs along the top, and
the terminal taking the rest. **Wire** in the top bar opens the inspector:
topology, every frame on the segment, and the switch's MAC table.

## Licence

unkernel is MIT AND GPL-2.0-only; the kernel and root images are its own. The
code here is MIT.
