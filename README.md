# unlab

A Linux network lab that runs entirely in a browser tab. Every machine is a real Linux kernel (the same [unkernel](https://github.com/pithings/unkernel) build that unkernel.dev runs), and they are all cabled to one virtual layer-2 switch, so you can ping, route, serve and break things between them.

```
~ ⇒ ping -c 1 10.88.0.12
64 bytes from 10.88.0.12: seq=0 ttl=64 time=1.4 ms
```

That reply came out of a second Linux kernel, running in another thread, in the same tab.

Try it at https://gregbell.github.io/unlab/.

## Running it

```sh
npm install
npm run distros alpine        # add `debian` for the 72 MB image too
npm run dev
```

Open the printed URL. A new lab starts empty: pick a starting point, type a line such as `spawn 2 alpine`, or use **Add machine**.

## Using it

Everything the lab can do is a command, and every surface runs the same commands:

- **Buttons** in the rail, pane headers and switch faceplate.
- **The command bar**: ⌘K on macOS, Ctrl+/ elsewhere. It completes as you type, says what a line will do before it runs, and asks before it removes anything.
- **An agent** in the same browser, through [WebMCP](https://developer.chrome.com/docs/ai/webmcp/imperative-api). The agent panel sets which tools run at once, which ask you first, and which are off.

| Command                                                       | Does                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `spawn 2 alpine [--mem 512] [--cpus 2] [--disk 8] [--no-net]` | Boots machines, plugged into switch0 unless told otherwise               |
| `rm node3`                                                    | Removes a machine and its disk, after you confirm                        |
| `ls`                                                          | Lists machines, addresses and link states                                |
| `exec all -- ping -c 1 10.88.0.12`                            | Types the command into each machine's console and reports each exit code |
| `sh node2`                                                    | Opens another shell on a machine                                         |
| `link down node2`                                             | Cuts a cable; `link up` reconnects it                                    |
| `capture arp or node2`                                        | Filters the capture and opens the Wire view                              |
| `focus node2 [--main \| --max]`                               | Moves the keyboard, and optionally promotes or maximises the pane        |
| `boot node4`                                                  | Boots a failed machine again                                             |

Targets can be one machine, a list (`node1,node3`), a glob (`node*`) or `all`. Globs and `all` take ready machines only.

The dock under the terminals shows the switch and the frames crossing it. **expand** opens the Wire view: the MAC address table, the whole capture with a filter, each frame decoded, and **save .pcap**.

## How it is built

Vanilla TypeScript and custom elements (Lit, light DOM), one store, one command registry.

```
src/
  main.ts      the composition root: the only module that sees every layer
  net/         pure packet code: frames, decode, capture filter, pcap
  model/       the lab as plain data: one reducer, plans, panes, selectors, the store
  capture/     the capture ring that thousands of frames a second flow into
  commands/    the grammar engine and the verbs; every button, bar line and tool runs one
  agent/       WebMCP tool registration, policies and approvals
  runtime/     workers, kernels, the switch, terminal screens; it executes effects
  ui/          the elements, the shared styles and the design tokens
```

The parts that matter most:

- **State changes in one place.** `update(state, event)` in `src/model/` is the only function that changes the lab. It returns the new state and a list of effects, plain data such as `vm/boot` or `link/set`, which the runtime executes and answers with events. The rules (lifecycle, names, hues, ports, pane parking) are pure and tested without a browser.
- **Fast data stays out of the store.** Frames go into a ring buffer with an incremental filter index, and terminal bytes go straight to their terminal. Elements hear about new frames at most once per animation frame.
- **One way to run anything.** A button runs a command line through the same parser as the bar, and an agent tool turns its input into a bar line too. Previews, error sentences and confirmations come from the verb, so the three surfaces cannot drift.
- **Exit codes are real.** Guest setup installs a prompt that emits OSC 133 marks, so `exec` reads each command's exit status from the console itself, and refuses a shell that is still running something.
- **Layers are enforced.** `scripts/check-imports.ts` fails the build when a layer imports one it may not, or reaches past another layer's `index.ts`.

The design decisions, with the alternatives that lost, are in `.audit/arch/synthesis.md`. `.audit/decisions.tsv` logs every decision made during the rewrite.

## Checking it

```sh
npm run check              # typecheck, lint, import layers, unit tests, build
npm run test:browser       # elements in real Chromium; boots real kernels in workers
npm run test:integration   # two real kernels in Node, pinging across the switch
npm run test:e2e           # the built app with real kernels, driven like a person would
```

The browser and e2e suites need Chromium. Playwright's own download is used when it runs on your machine; otherwise they fall back to `chromium` on your `PATH`, or `CHROMIUM_PATH`.

## The exact same builds

Nothing here is rebuilt or repacked. The kernel is `unkernel.wasm` from the pinned `unkernel` npm package. The root images are the `.erofs` assets from the GitHub release matching that package version; `npm run distros` reads the release's `distros.json`, downloads each image and checks its size and SHA-256 before writing it. `public/distros/distros.json` records what was mirrored, down to the upstream build id.

The Add machines form sizes each guest independently of its peers. The defaults are one CPU, 256 MiB of RAM and a sparse 4 GiB disk. The disk consumes browser storage as the guest writes to it. For example, `spawn 2 alpine --mem 512 --cpus 2 --disk 8` boots a pair with two CPUs, 512 MiB of RAM and an 8 GiB disk apiece.

## Limits

- **Eight machines.** One per switch port and one per machine hue.
- **IPv4 only.** The switch discards IPv6.
- **One NIC per machine.** Routers between separate segments need address aliases rather than a second interface.
- **The lab has no internet uplink.** Machines reach each other, not the outside world.
- **Machines and disks are saved in this browser.** Reloading cold-boots each node with its own IndexedDB-backed ext4 disk and restores its switch port and cable state. Shell processes and capture history start fresh. Removing a machine deletes its disk. One tab at a time owns the lab.
- **WebMCP is an origin trial.** In a browser without it the agent panel still shows the tools and policies, and says no agent can call them yet.

## Licence

unkernel is MIT AND GPL-2.0-only; the kernel and root images are its own. The code here is MIT. The desktop background is adapted from the Big Moon wallpaper in [NOS](https://github.com/gregbell/nos).
