# unlab

A Linux network lab in one browser tab, built on
[pithings/unkernel](https://github.com/pithings/unkernel). Pooya Parsa and the
unkernel contributors made it possible to boot a real Linux kernel in
WebAssembly. `unlab` connects those machines to a virtual Ethernet switch so you
play with networking between linux boxes right in a tab. Send a ping, pull a
cable, and see what happens to the packets.

**[Open the live lab](https://gregbell.github.io/unlab/)** ·
[Run locally](#run-locally) · [Contribute](#contribute)

![Two Alpine consoles above a live packet capture and an eight-port switch. node1 receives three ping replies from node2 at 10.88.0.12.](docs/images/first-ping.png)

## Follow your first ping

1. Open the live lab and select **Boot 2 machines**. When both Alpine guests are
   ready, their addresses appear beside their names.
2. Select **Ping node2**. The replies appear in the `node1` console. In the
   capture below it, the first ARP request asks who has `10.88.0.12`. The ICMP
   echo requests and replies follow.
3. Select **expand** in the capture to open the Wire view. Select a frame to
   inspect its headers, or choose **save .pcap** to download a capture you can
   open in Wireshark.

To see what a broken link looks like, press `Esc` to return to the consoles and
click the cable above port 2. Ping again, then click the cable to reconnect it.

## Lab commands

Open the command bar with `⌘K` on macOS or `Ctrl+/` elsewhere. It completes
commands as you type and previews their effects. Run Linux commands directly in
a guest console, or use `exec` in the bar to address a guest by name.

| Command bar example                          | What it does                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ls`                                         | List machines, addresses, and link states.                                                                             |
| `spawn 2 alpine --mem 512 --cpus 2 --disk 8` | Add two Alpine machines with 512 MiB of RAM, two CPUs, and an 8 GiB disk each. Use `--no-net` to leave them unplugged. |
| `exec node1 -- ping -c 1 10.88.0.12`         | Send one ping from node1 and read the exit code from its shell.                                                        |
| `link down node2`                            | Cut node2's cable. Reconnect it with `link up node2`.                                                                  |
| `capture arp or node2`                       | Open the Wire view with a filter for ARP or traffic involving node2.                                                   |
| `sh node2`                                   | Open another shell on node2.                                                                                           |
| `focus node2 --max`                          | Maximise or restore its pane. Use `--main` to promote it to the main pane.                                             |
| `boot node2`                                 | Retry a failed boot.                                                                                                   |
| `rm node2`                                   | Remove the machine and delete its disk after confirmation.                                                             |

Commands that accept multiple machines can take a list (`node1,node3`), a glob
(`node*`), or `all`. Globs and `all` select ready machines.

In browsers with WebMCP, an agent can use the lab commands too. The agent panel
lets you allow a tool, require approval, or turn it off.
[WebMCP API documentation](https://developer.chrome.com/docs/ai/webmcp/imperative-api)

## Network and storage

- The switch has eight ports and supports up to eight machines. Each guest has
  one network interface. The lab carries IPv4 traffic between guests and has no
  internet uplink.
- Each guest defaults to 256 MiB of RAM, a sparse 4 GiB disk, and two CPUs, or
  one CPU if the browser lacks multicore support. The disk uses browser storage
  as the guest writes to it.
- Reloading the page boots each machine from its own IndexedDB-backed ext4 disk.
  Switch ports and cable connections survive a reload. Shell processes and
  packet captures start fresh. One tab at a time owns the lab.

## Run locally

With Node.js 24 and npm installed, clone the repository and start the dev
server.

```sh
git clone https://github.com/gregbell/unlab.git
cd unlab
npm ci
npm run distros -- alpine debian
npm run dev
```

Open the URL printed by Vite. The distro download checks each root image's size
and SHA-256 against the unkernel release that matches the pinned npm package.
The kernel comes directly from that package's `unkernel.wasm`. The
[image manifest](public/distros/distros.json) records the upstream build IDs and
checksums.

## How it works

Each guest runs in its own worker. When Linux sends an Ethernet frame, the
[virtual switch](src/runtime/switch.ts) forwards it and the
[capture](src/capture/) records it. The Wire view decodes those same bytes.
Terminal output goes straight to the terminal, so the UI can update the capture
once per animation frame.

The [command registry](src/commands/verbs/) serves the buttons, command bar, and
agent tools. The [model](src/model/) turns events into state changes and
effects. The [runtime](src/runtime/) carries them out. For the reasoning behind
those boundaries, read the [architecture notes](.audit/arch/synthesis.md).

## Contribute

For a bug report, include the browser, guest distribution, and commands that
reproduce it. For a change, describe what someone can do or observe in the lab.
[Open an issue](https://github.com/gregbell/unlab/issues) ·
[Open a pull request](https://github.com/gregbell/unlab/compare)

After local setup, run the checks that cover your change.

| Command                    | Coverage                                                                     |
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm run check`            | Type checking, lint, import boundaries, unit tests, and the production build |
| `npm run test:integration` | Two Linux guests exchanging traffic across the switch in Node.js             |
| `npm run test:browser`     | UI components and guest workers in Chromium                                  |
| `npm run test:e2e`         | The built app, including the first boot, ping, and reload                    |

For the browser and end-to-end suites, install Chromium with
`npx playwright install chromium` or set `CHROMIUM_PATH` to a Chromium
executable.

## Licence and acknowledgements

unlab's code is available under the [MIT licence](LICENSE). Thank you to Pooya
Parsa and the [unkernel contributors](https://github.com/pithings/unkernel) for
the kernel, JavaScript SDK, and distro builds that power every machine in this
lab.
