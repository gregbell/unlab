# CLI stories

The vision is in `.audit/cli-vision.md`. The table at the end maps each ticked box to its tests. A box that is not ticked
says why under its story.

"Linked" means the lab page and the CLI are connected. The limits are today's: one lab in one tab, eight machines.

## The gate

### 0. One command gives a shell in a browser machine

As a person at a terminal, I can run `npx unlab.run`, type `ssh node1`, and be in a machine that runs in my browser,
with the internet reachable from it.

- [ ] On a computer that has never run it, `npx unlab.run` then `ssh node1` gives a shell, and the only step in the browser is the one permission it asks for.
- [x] In that shell, `curl -sI https://example.org` answers with a status line.
- [x] The same works on an Alpine, a Debian and a lab-image machine.
- [x] A 10 MiB file copied in with `scp` and back out has the checksum it started with.
- [ ] It all still works after the lab's window has been covered by the terminal for ten minutes.
- [ ] **Live run:** an agent given only a shell and the README boots two machines with `npx unlab.run`, copies a file from one to the other over SSH, and the person's only click is the browser's permission.

Not ticked: the first and the live run need the published package and a person at a browser that asks.

## The link

### 1.1 The CLI finds the lab

As a person, I can start the CLI and have it reach my lab without setting anything up.

- [x] With the lab open in a tab that has linked before, `npx unlab.run` is linked within three seconds, and the person does not touch the browser.
- [x] With no lab open, the CLI opens the lab in the default browser, and it links.
- [x] With the lab open in a tab that has never linked, the page the CLI opens hands the request to that tab and says so. The lab is not loaded twice.
- [ ] The first time, the browser asks once for permission to reach this computer. Until it is given, the CLI says what it is waiting for, and the lab says how to give it after a refusal.
- [x] Once linked, the CLI prints one line with the machines and their states, then its prompt.
- [ ] The installed app links as a tab does.

Not ticked: the browser's question has not been seen, as headless Chromium answers no without asking. What the CLI and the
lab say before and after it are tested (`src/link/link.test.ts`, `src/ui/cli-link/cli-link.browser.test.ts`), and Chromium
155 was seen to refuse the connection without the permission and allow it with it. The installed app was not tried.

### 1.2 The lab shows the link

As a person, I can see in the lab whether a CLI is linked, and turn the link off.

- [x] The status line shows the link beside `webmcp:`: off, waiting or linked.
- [x] A lab that has never been asked to link makes no request to this computer, so an ordinary visitor sees no permission prompt.
- [x] The person can turn the link off in the lab. It then stops trying, and that survives a reload.
- [x] With a keyboard and a screen reader, the state can be read and changed.

### 1.3 Only the lab and the CLI talk

As a person, I can run the CLI without opening my computer to anything else.

- [x] The CLI listens on `localhost` only.
- [x] A WebSocket from any page but the lab's is refused. `--origin` names a local copy of the lab.
- [x] A second `npx unlab.run` while one runs says so, and uses the first.
- [x] The lab and the CLI tell each other their versions. Ones that cannot work together say which to update, in one sentence, and do nothing else.

### 1.4 The link survives real use

As a person, I can reload the lab, cover its window or quit the CLI, and nothing is left broken.

- [x] After a reload, the lab links again by itself. The CLI says the machines are booting, and its prompt works once they are ready.
- [x] When the CLI quits or is killed, the lab shows it within five seconds, the machines run on, and the gateway serves package repositories as before.
- [x] With the lab's tab hidden for ten minutes, a lab command from the CLI returns within a second, and a key typed over SSH is echoed within 100 ms.
- [x] That box is shown by a test that starts Chromium itself and hides the tab, since a page Playwright drives is never hidden.

## Commands

### 2.1 The prompt runs lab commands

As a person, I can type at the CLI what I would type in the command bar.

- [x] A line that is not one of the CLI's own goes through the parser the bar uses, and prints what the bar's log would say.
- [x] `ls`, `spawn 2 alpine`, `topology`, `help` and `help spawn` work with no code of their own in the CLI.
- [x] A command that cannot run prints the lab's one sentence.
- [x] A command that asks for confirmation in the bar asks in the terminal, with the same text. The agent panel's `ask me` settings do not apply.
- [x] `exec node1 -- false` prints the guest's output and reports its exit code.
- [x] The lab's log shows which lines came from the CLI.
- [x] `help` at the prompt lists the CLI's own words with the lab's commands, in the same voice.

### 2.2 One command and out

As an agent or a script, I can run one lab command from a shell and read its result.

- [x] `npx unlab.run exec node1 -- uname -a` prints the output and exits with the guest's exit code. It uses a CLI that is running, or links by itself and waits for the lab.
- [x] `--json` prints the data the matching agent tool returns.
- [x] Without a terminal on stdin it never prompts: a command that needs confirmation is refused unless `--yes` is given.
- [x] A lab that does not link within the wait is one sentence and a non-zero exit.

### 2.3 The prompt is pleasant

As a person, I can work at the prompt as I do in a shell.

- [x] Tab completes verbs, machine names and options from the lab's own completer.
- [x] History is kept between runs.
- [x] Ctrl-C cancels the line or the running command. Ctrl-D or `exit` leaves.

## SSH

### 3.1 A shell in any machine

As a person, I can open an SSH session into any machine that is running.

- [x] `ssh node1` gives an interactive shell as `user`, and `ssh root@node1` as root. Leaving it returns to the prompt.
- [x] The terminal's size reaches the guest, and so does a resize.
- [x] It works on Alpine, Debian and the lab image.
- [x] It works on a machine with `--no-net` and on one with `--no-gateway`.
- [x] A machine with a chosen name is reached by it: `ssh web`.
- [x] The first connection to a machine takes under three seconds, and later ones under one.
- [x] `ssh node1 -- uname -a` runs one command and exits with its code.
- [x] A machine that is off, booting or failed is refused in one sentence that says which, and what would work.

### 3.2 SSH from any terminal

As a person or an agent, I can use my own `ssh`, `scp` and `rsync` against a lab machine.

- [x] While the CLI runs, `ssh node1.unlab` works from another terminal, after one `Include` line in `~/.ssh/config`.
- [x] The CLI prints that line, and `npx unlab.run ssh-config` prints it again. The CLI never edits the person's files.
- [x] `scp` and `rsync` copy a 10 MiB file each way with its checksum unchanged.
- [x] `ssh -L 8080:localhost:80 node1.unlab` reaches a web server in the guest.
- [x] No password or host-key question is ever asked, also after the machine reboots, and after it is removed and a new one takes its name.
- [x] The CLI uses its own key and known-hosts file, in its own directory. It reads and writes none of the person's.

### 3.3 The machine is left as it was

As an agent building a scenario, I can use SSH without changing what the scenario sees.

- [x] The server, its host key and the authorised key are in the machine's memory. None is on a disk, in a checkpoint taken meanwhile, or there after a reboot.
- [x] The server listens on the machine's loopback only, on a port that is not 22. Another lab machine cannot connect to it.
- [x] An SSH session puts no frame on any switch, and the capture shows none.
- [x] A scenario's own SSH server on port 22 runs beside it, on the lab image.
- [x] Only the CLI's key is accepted. Passwords are refused.
- [x] The README says what runs in a machine for SSH, and where.

### 3.4 The server is built and pinned

As a maintainer, I can rebuild the SSH server and know what is in it.

- [x] One script builds a static aarch64 dropbear from a pinned release, as the NIC helper is built, and records the checksum of what it built from.
- [x] The lab fetches it on the first SSH connection, and checks its checksum. A visitor who never links downloads nothing more than today.
- [x] One binary runs on all three images.
- [x] Its licence is published with it.

## Any port

### 4.1 Forward a port

As a person, I can reach a service in a machine from my own browser and tools.

- [x] `forward web 8080:80` makes `curl localhost:8080` answer from nginx on a lab-image machine.
- [x] `forward` alone lists what is forwarded, and `forward --rm 8080` ends one.
- [x] A port that is taken on this computer is refused in a sentence that names it.
- [x] Forwarded ports listen on `localhost` only, and close when the CLI quits or the machine is removed.

## Internet

### 5.1 Machines reach the internet

As an agent building a scenario, I can have machines fetch what the scenario needs.

- [x] While linked, a machine with a gateway resolves a name and completes `curl https://example.org`, with the certificate checked in the guest.
- [x] It starts on running machines within five seconds of linking, with no reboot.
- [x] It ends within five seconds of the CLI quitting. `apk add` still works then, as today.
- [x] A machine with `--no-gateway` or `--no-net` gets none.
- [x] A 100 MiB download has the right checksum, and CI records its rate.
- [x] Eight machines download at once and each finishes.
- [x] On Debian, `apt install` works while linked.

### 5.2 It is clear where traffic goes

As a person, I can see that a machine's traffic leaves from my computer.

- [x] `ls` and a machine's details say whether its gateway reaches package repositories only or the internet through the CLI.
- [x] `status` in the CLI shows the open connections, by machine, and the bytes each way.
- [x] `--log` prints each connection a machine opens: the machine, the host and the port.
- [x] The README says what the relay does not carry: `ping`, UDP, IPv6 and inbound connections.

### 5.3 My own network is not exposed

As a person, I can link the CLI without giving lab machines my local network.

- [x] A connection to this computer's loopback, to a private or link-local address, or to a carrier-grade NAT address is refused, and the guest sees the connection refused.
- [x] That holds when a public name resolves to such an address: the check is on the address the CLI connects to.
- [x] `--lan` allows them, and the CLI says so when it starts.
- [x] Only the lab's page can open connections through the relay.

## Keeping what exists

### 6.1 Nothing changes without the CLI

As a person who never runs the CLI, I find the lab as it is today.

- [x] A lab that has never linked sends nothing to this computer, shows no prompt, and has today's gateway.
- [x] The page downloads no more than it does today before the first link.
- [x] A saved lab from before opens as it did.
- [x] The WebMCP tools, their defaults and the agent panel are unchanged, and an agent can use them while a CLI is linked.
- [x] The existing unit, browser, integration and end-to-end suites pass.

### 6.2 It is published and explained

As a person, I can find out how to use the CLI and trust what I run.

- [ ] `npx unlab.run` installs from npm a package that CI built from this repository and published with provenance.
- [x] It runs on Node.js 22.12 or later, on Linux and macOS.
- [x] The README has a section for it in its own voice: start it, open a shell, copy a file, reach the internet, and what to do when it does not link.
- [x] What's new has an entry.

Not ticked: nothing is published. The workflow is `.github/workflows/cli.yml`, and npm needs an account's token in the
repository first.

## Build order

Stories 6.1 and 6.2 are met a part at a time, with each step.

1. Spike the link in a real window: the permission prompt, a hidden tab, the installed app. The first three decisions below.
2. The link, and lab commands at the prompt (1.1 to 1.4, 2.1).
3. Build the SSH server (3.4).
4. Streams into a machine, and SSH (3.1, 3.2, 3.3).
5. The relay, and the gateway that switches to it (5.1, 5.2, 5.3).
6. Forwarded ports (4.1).
7. One command and out, and the prompt's comforts (2.2, 2.3).
8. Publish, the README and the gate (6.2, 0).

## How the decisions were settled

| Decision | Settled |
| --- | --- |
| How the lab learns a CLI is there | A fixed port, 27122, tried about once a second, only after the person linked once or the CLI opened the lab at `#cli`. A page opened beside an open lab hands over with a BroadcastChannel |
| What the browser's permission prompt needs | Open. Needs a person at a browser |
| Where the lab's end of the link runs | Commands on the page: hidden for seven minutes, its WebSocket answered within 4.7 ms (`.audit/spikes/cli-link/hidden-ws.ts`). Streams in each machine's worker. Redialling is timed by a worker, as a hidden page's timers are held |
| Whether Chrome freezes a hidden lab | Not tested under Energy Saver. The lab holds a lock, which exempted a tab when freezing shipped |
| Whether dropbear builds with `zig cc`, static | It does, the same bytes each time. So do sftp-server, which `scp` needs in the guest, and rsync, which no image has |
| Which guest port the SSH server takes | 47022, and the next free one up to 47041 |
| Whether packages go through the CLI while linked | They do |
| Which addresses the gateway keeps for itself while linked | No more than before. Names are looked up by the CLI and the guest gets their real addresses |
| How the CLI and the lab stay in step | One protocol number, checked at hello |

Built otherwise than the vision says: the relay is not Wisp. unkernel's Wisp client reports a connection open before the
far end has answered, has no half-close and does not hold a fast sender back, so a refused port would read as one that
opened and closed. Connections are streams of the link's own instead (`src/streams/mux.ts`).

The port was 47122 in version 0.1.0. Linux gives such ports to outgoing connections, and one that has it keeps the CLI
from listening.

Found on the way: the lab wrote Alpine's repositories as one line that only `apk` reads, so the image's installer of
missing commands, which its `curl` uses for most options, never worked. They are two lines now, also on machines that
have the one.

## Left out on purpose

- Several labs or tabs at once.
- A CLI that runs machines without a browser.
- An internet switch per machine. `--no-gateway` is the way to leave one out.
- The agent panel's approvals for CLI commands.
- Inbound connections from the internet to a machine.
- UDP, ICMP and IPv6 through the relay.
- Windows.
- Firefox and Safari, until one is tried.
- Editing the person's SSH configuration.

## Evidence

| Story | Box | Test |
| --- | --- | --- |
| 0 | `curl -sI https://example.org` answers, on each image | by hand on 2026-11-25 through the relay, as it needs the internet: HTTP/2 200 on alpine, debian and lab. `test/integration/cli-relay.test.ts` repeats it against servers on this computer |
| 0 | 10 MiB by `scp` and back | `test/integration/cli-ssh.test.ts`: scp and rsync copy 10 MiB each way on each image; `e2e/cli.spec.ts`: scp copies 10 MiB into a machine in the browser and back |
| 1.1 | Linked within three seconds when it has linked before | `e2e/cli.spec.ts`: a lab that has linked before is linked within three seconds of the CLI starting |
| 1.1 | With no lab open, the CLI opens it and it links | `e2e/cli.spec.ts`: the CLI opens a lab that links, gives a shell, and links again by itself after a reload. The browser is opened with `xdg-open` or `open`, which the test stands in for |
| 1.1 | A page opened beside the lab hands over | `e2e/cli.spec.ts`: a page the CLI opens beside an open lab hands the link to it, and does not load the lab again |
| 1.1 | One line with the machines, then the prompt | `e2e/cli.spec.ts`: the CLI opens a lab that links…; `cli/src/prompt.test.ts`: the machines are one line with their states |
| 1.2 | The status line shows the link | `src/ui/cli-link/cli-link.browser.test.ts`: each state; `e2e/cli.spec.ts`: throughout |
| 1.2 | Never asked, it makes no request | `e2e/cli.spec.ts`: a lab that has never linked reaches for nothing, and downloads nothing for SSH; `src/link/link.test.ts`: a lab that was never asked to link dials nothing and keeps no clock |
| 1.2 | Turned off, over a reload, by keyboard, with axe | `e2e/cli.spec.ts`: the link is turned off in the lab, by keyboard, and stays off over a reload; `src/ui/cli-link/cli-link.browser.test.ts` |
| 1.3 | `localhost` only | `test/integration/cli-link.test.ts`: it listens on this computer alone |
| 1.3 | Only the lab's page; `--origin` | `test/integration/cli-link.test.ts`: only the lab's own pages are taken; a machine's channel needs the token that the lab was given; `e2e/cli.spec.ts` links a local copy |
| 1.3 | A second CLI uses the first | `e2e/cli.spec.ts`: a second CLI uses the first |
| 1.3 | Versions | `test/integration/cli-link.test.ts`: a lab of another version is told which to update, and nothing else happens |
| 1.4 | A reload | `e2e/cli.spec.ts`: the CLI opens a lab that links, gives a shell, and links again by itself after a reload |
| 1.4 | The CLI is killed | `e2e/cli.spec.ts`: a CLI that is killed leaves the lab as it was, within five seconds |
| 1.4 | A hidden tab, shown by a test that starts Chromium itself | `e2e/cli-hidden.spec.ts`: a lab behind other windows answers the CLI and SSH as one in front does. CI hides it for 30 s with the browser's one-a-minute timers brought forward to 10 s; HIDDEN_MINUTES=10 waits ten minutes at its own pace |
| 2.1 | All boxes | `e2e/cli.spec.ts`: the prompt runs the lab's commands, asks for what asks first, and the lab shows who ran them; one command from a shell…; `src/link/link.test.ts`: a line from the CLI |
| 2.2 | All boxes | `e2e/cli.spec.ts`: one command from a shell: its output, its exit status, its data, and no question without a terminal; one command with no CLI running links by itself; `test/integration/cli-link.test.ts`: a command without a lab gives up in a sentence; `cli/src/options.test.ts` |
| 2.3 | All boxes | `e2e/cli.spec.ts`: the prompt completes with the lab's words, keeps its history, and Ctrl-C and Ctrl-D do what they do in a shell; `cli/src/prompt.test.ts` |
| 3.1 | A shell as `user` and root, on each image, with no gateway and no network, in time | `test/integration/cli-ssh.test.ts`: a shell as user and as root, quickly, in … |
| 3.1 | The terminal's size, and a chosen name | `test/integration/cli-ssh.test.ts`: the terminal's size reaches the guest; `e2e/cli.spec.ts`: the prompt completes… (40 120 over `ssh` at the prompt); no file of SSH's… (`web`) |
| 3.1 | One command's status; a machine that is off, booting or failed | `test/integration/cli-ssh.test.ts`: a command's exit status is the shell's, at the CLI too; a machine that is off, booting or failed is refused with a sentence |
| 3.2 | Any terminal, `scp`, `rsync`, `ssh -L`, the `Include` line | `test/integration/cli-ssh.test.ts`: scp and rsync…; ssh -L reaches a web server in the guest; a terminal's own environment does not matter to ssh; `test/integration/cli-link.test.ts`: ssh-config prints the line, and edits nothing |
| 3.2 | No question is asked, after a reboot or under a name that is used again | `e2e/cli.spec.ts`: no file of SSH's is in a checkpoint, and a reboot takes it away and the next connection puts it back |
| 3.2 | Keys of its own | `test/integration/cli-link.test.ts`: its keys are its own, and only its person can read them |
| 3.3 | All boxes | `test/integration/cli-ssh.test.ts`: nothing of it is on a disk or on a network, and only the CLI's key opens it; an SSH session puts no frame on the switch; a scenario's own SSH server runs beside it on port 22; it takes the next port when a scenario has the first; it is put back when someone ends it; `e2e/cli.spec.ts`: no file of SSH's is in a checkpoint… |
| 3.4 | All boxes | `scripts/ssh-server.test.ts`; rebuilt on 2026-11-25 to the same bytes; `e2e/cli.spec.ts`: a lab that has never linked… downloads nothing for SSH |
| 4.1 | All boxes | `test/integration/cli-ssh.test.ts`: forward leads to a port in a machine, and says what is taken; `e2e/cli.spec.ts`: a forwarded port closes when its machine is removed |
| 5.1 | On and off a running machine, a name, no gateway, 100 MiB, eight at once | `test/integration/cli-relay.test.ts`: a running machine reaches nothing before the CLI links…; a machine looks a name up…; a machine without a gateway gets none; 100 MiB arrive whole (43 MiB/s here); eight machines download at once; it ends within five seconds…; `e2e/cli.spec.ts`: a machine in the browser reaches the internet while linked, and nothing after |
| 5.1 | The certificate is checked; `apt install` | by hand on 2026-11-25: `apt-get install jq` on debian through the relay; a site with an expired certificate is refused by the guest |
| 5.2 | `ls` and the details; `status`; `--log` | `src/commands/verbs/ls.test.ts`: says which machines reach the internet while a CLI is linked; `src/model/selectors.test.ts`: its uplink is what the gateway reaches now; `test/integration/cli-relay.test.ts`: status and --log say what is open, by machine |
| 5.3 | All boxes | `cli/src/relay.test.ts`; `test/integration/cli-relay.test.ts`: it ends within five seconds of the CLI quitting, and a link from another CLI brings it back; `cli/src/relay.test.ts`: with --lan a machine reaches this computer, and still not the CLI's own port; `test/integration/cli-link.test.ts`: a machine's channel needs the token |
| 6.1 | Never linked; saved labs; WebMCP beside it | `e2e/cli.spec.ts`: a lab that has never linked…; an agent uses the lab's tools while a CLI is linked; `e2e/saved-labs.spec.ts` |
| 6.2 | Node.js 22.12, on Linux and macOS | the matrix of `.github/workflows/cli.yml`, which passed on both: the link's rules, not SSH into a machine, which ran on Linux with Node.js 24 |
| 0 | On the live lab, on each image | by hand on 2026-11-25, with `unlab.run@0.1.0` from npm and https://unlab.run in headless Chromium, given the permission beforehand: `ssh`, `curl -sI https://example.org` and 10 MiB by `scp` each way on alpine, debian and lab. A lab that had never linked dialled nothing, and one without the permission said `cli: blocked` |
| 6.1 | The existing suites pass | CI on pull request 27 |
