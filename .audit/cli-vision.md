# The unlab CLI: a vision

Written 2026-11-25, before any of it was built. The stories, and how it was settled, are in `.audit/cli-stories.md`.

## The idea

One command in a terminal reaches the machines that run in a browser tab.

```
$ npx unlab.run
Linked to the lab: node1 (alpine), node2 (debian)

unlab> ssh node2
user@node2:~$ curl -sI https://example.org | head -1
HTTP/2 200
user@node2:~$ exit

unlab> forward node1 8080:80
unlab> spawn 1 lab --name web
```

While the CLI runs:

- `ssh` opens a real SSH session into any machine, on any image, with nothing to install or configure.
- `ssh node2.unlab`, `scp` and `rsync` work from any other terminal on the same computer.
- Every machine with a gateway reaches the internet, through this computer.
- Every lab command works from the prompt, as it does in the command bar.

When the CLI stops, the lab is as it was: machines in a tab, with package repositories as their only way out.

## Who it is for

- **A person** who wants their own terminal, editor and tools on a lab machine, and wants machines that can fetch what
  a scenario needs.
- **A coding agent with a shell**, which can then copy files in and out, run long commands and read real exit codes
  over SSH. It needs no browser automation for that.

## Why it needs a program on the computer

A lab machine runs inside a browser tab. It has no address anything can connect to, and a web page cannot open a plain
internet socket or accept a connection. A small program on the same computer can do both. The tab connects out to it,
and the two carry bytes for each other.

```
  your terminal                                your browser
  ssh ───────► unlab CLI ◄──── WebSocket ──── lab tab ───► machines
               on localhost                   (each machine in its own worker)
  internet ◄── unlab CLI ◄──── WebSocket ──── a machine's gateway
```

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| The CLI | npm package `unlab.run`, command `unlab` | Listens on `localhost`, shows the prompt, runs `ssh`, opens internet sockets for the machines |
| The link | The lab page | Connects to the CLI, passes it the machine list, runs the command lines it sends |
| Streams | Each machine's worker | Carry bytes between the CLI and a TCP port inside the machine |
| The SSH server | A static dropbear, fetched by the lab on first use | Runs in the machine's memory, on its loopback only |
| The relay | The CLI, behind each machine's gateway | Turns a machine's outbound connections into real ones from this computer |

## How each part works

**Linking.** The CLI listens on a fixed `localhost` port and accepts a WebSocket only from the lab's own page. A lab
that has linked before connects again by itself. Otherwise the CLI opens the lab in the browser. The first time, the
browser asks the person whether unlab.run may reach programs on this computer. The lab's status line shows the link
beside `webmcp:`.

**Commands.** A line typed at the prompt goes to the lab's command registry, through the parser the command bar and
the agent tools use. The CLI adds only its own few words: `ssh`, `forward`, `status`, `exit`. A command that asks for
confirmation in the bar asks in the terminal. The agent panel's `ask me` settings do not apply to the CLI: the person
who started it is the person at the keyboard.

**SSH.** On the first connection to a machine, the lab writes a static dropbear into the machine's `/run`, with a host
key and the CLI's public key, and starts it on a loopback port that is not 22. The machine's worker then connects the
CLI's stream to that port. The CLI keeps its own key pair and known-hosts file, and runs the computer's own `ssh`
against them. Nothing is written to a machine's disk, nothing listens on a lab network, and a reboot removes all of
it. The next connection sets it up again.

**Internet.** A machine with a gateway already has `10.0.2.15` and a default route, which today lead only to package
repositories. While the CLI is linked, the gateway sends every outbound connection to the CLI, which opens it from
this computer. It takes effect on running machines, and ends when the CLI stops. unkernel's gateway already speaks the
relay protocol this needs (Wisp), so the lab side is a change of what sits behind the gateway.

## Principles

- **The lab stays in the tab.** The CLI holds no machines and no state a lab needs. Closing it loses nothing.
- **Nothing changes without it.** A visitor who never runs the CLI sees no prompt, downloads nothing more, and has the
  gateway they have today.
- **A machine is left as it was.** SSH adds no file to its disks and no service to its networks, so a scenario and its
  checkpoints are not disturbed.
- **This computer's network is not the lab's.** A machine cannot reach this computer's `localhost` or its local
  network through the relay unless the person says so.
- **One language.** The CLI sends command lines. It has no second set of lab commands to keep in step.

## What the user decided, 2026-11-25

- The SSH server is a static dropbear binary placed in the machine, not a package install.
- While the CLI is linked, every machine can use the internet. There is no switch per machine.
- CLI commands do not go through the agent panel's `ask me` settings.
- One lab at a time, in one tab, as today.
- The command is `npx unlab.run`.

## What is known

Measured on 2026-11-25 against unkernel `0.2.0-261123-8f039c5`:

- **SSH reaches a guest.** The OpenSSH client logged in to dropbear in an Alpine guest under Node, through a host port
  piped to `vm.connect()`. Login and one command took 0.21 s. A 1 MiB upload matched by SHA-256 in 0.33 s.
- **A page can reach the CLI, once allowed.** In Chromium 155, a WebSocket from `https://unlab.run` to `ws://127.0.0.1`
  fails with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` until the `local-network-access` permission is granted.
  Granted, it works from the page and from a worker, and the server sees the origin `https://unlab.run`. This ran
  headless, where the permission is denied without a prompt. The prompt itself has not been seen.
- **dropbear 2026.91 has what the design needs.** `-D` names the directory of the authorised keys and `-r` the host
  key, so both can live in `/run`. `-i` on pipes fails with `Not a socket`, so the server needs a loopback port.
  Alpine's own build links three shared libraries, so Debian needs a static build.
- **The images.** Alpine and Debian ship no SSH server. The lab image ships OpenSSH, which a scenario may run on port 22.
- **A binary can be placed in a guest.** The lab already does it for its NIC helper: a static aarch64 program built
  with `zig cc`, written with `vm.exec` and its `input` (`src/runtime/machine-nics.ts`).
- **The relay protocol is small.** unkernel's client uses four Wisp message types (connect, data, continue, close) and
  does not refuse a local address.
- **A hidden tab keeps its workers.** `.audit/spikes/frames.md`, section 3: in a hidden tab the page's timers are held
  to 1 s and then to one a minute, while a worker's timers stay within 45 ms and messages are not slowed. So the
  streams and the relay belong in the machines' workers.

Not known yet:

- What the browser's permission prompt says, whether it needs a click on the page first, and whether the installed
  app asks again.
- Whether WebSocket messages reach a hidden page as promptly as worker messages do.
- Whether Chrome's Energy Saver freezes a hidden lab. Tabs that hold a lock were exempt when freezing shipped, and
  the lab holds one, but this has not been tested.
- Whether dropbear builds statically with `zig cc`, and how large it is.

## Not part of this

- Several labs or tabs at once.
- A CLI that runs machines itself, without a browser.
- Inbound connections from the internet to a machine.
- UDP, ICMP and IPv6 through the relay. unkernel's gateway carries outbound IPv4 TCP and DNS.
- Windows. Firefox and Safari, until one of them is tried.
- Editing the person's `~/.ssh/config`. The CLI prints the one line to add.
