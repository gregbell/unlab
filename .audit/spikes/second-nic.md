# Spike: a second NIC for a guest

Question: unkernel's `kwnet` drives one device. Can a guest get an ordinary `eth1` without a kernel change?

Build and run, from `.audit/spikes/second-nic`:

    zig cc -target aarch64-linux-musl -static -Os -s -o unlab-nic unlab-nic.c
    node nic.mjs ../../../public/distros/alpine.erofs          # offload as shipped
    node nic.mjs ../../../public/distros/alpine.erofs plain    # offload off

Result, 2026-11-24, unkernel 0.2.0-261123-8f039c5, Node 24: VERIFIED.

- A 46 KB static helper opens `/dev/net/tun`, makes a TAP device called `eth1` with a chosen MAC, and relays
  length-prefixed frames on its stdin and stdout. The page starts it with `vm.spawn(..., { pty: false })`, so the
  frames cross on unkernel's own vsock pipes. No kernel change and no vsock code.
- Three guests, the middle one with two NICs and forwarding on: ping crosses it in 2 to 5 ms.
- With `kwnet`'s offload left on, an 8 MB TCP transfer through the router stopped at 6.4 MB and transfers to or from
  the TAP side moved 0 bytes. `kwnet` sends segments larger than the MTU with no checksum, and a TAP device
  checks both.
- With checksum offload and TSO turned off on `eth0` (`ETHTOOL_STSO` and `ETHTOOL_STXCSUM`, which the driver allows),
  the same transfer arrives whole in 0.7 s and no frame is larger than 1514 bytes.

Consequence: every guest runs `eth0` with offload off, extra NICs are TAP devices, and captured TCP frames are
wire-sized.

# Also checked on 0.2.0-261124-c08e977

`.audit/spikes` keeps no script for these; the integration tests that follow do.

- `strace` runs to completion.
- A blank `CowDisk` in `disks` appears as the next `/dev/wd*` with the size asked for.
- `poweroff`, `reboot` and `halt` in either image end the kernel in about 0.5 s with codes 0, 2 and 1.
