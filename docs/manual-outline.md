# <https://unlab.run> Manual

Table of contents

The chapters to write, in reading order. How to write them is in the
[style guide](manual/STYLE.md).

## Introduction

- What <https://unlab.run> is
- The lab: Linux machines, virtual networks, and persistent storage
- The role of the optional connection to your computer
- How to use the Manual and the Exercises, and the Manual's conventions and
  notation

## Getting started

1. **Start Linux machines in your browser.** Open <https://unlab.run>, choose
   **Boot 2 machines** in the Welcome window, open a machine's terminal, and run
   `hostname`.
2. **Keep a file across a reload.** Answer **What happens when I close the
   tab?** here. Write the machine's name to a file with
   `hostname > ~/my-machine`, refresh, and read it back with `cat ~/my-machine`.
   Reopening the lab in the same browser profile restores the desktop layout and
   each machine's disks. Machines that were running boot again with fresh shell
   sessions. Machines that were off stay off.
3. **Install software on Alpine or Debian.** Show how to install `curl` with
   `apk` or `apt` in the guest and check it with `curl --version`. Through the
   package gateway, the guest can fetch packages from the configured
   repositories without the CLI connected. Ordinary public websites are still
   out of reach from the guest.
4. **Ping the other machine.** Find its address in its Configuration window or
   with `ip addr`, and send a ping from the first machine. Show the expected
   reply. Point to Machines for adding more, to Networks, including its Packet
   capture section, for further reference, and to the Exercises for
   investigations.

Getting started is complete in the browser. Continue directly to
[Connecting from your computer](#connecting-from-your-computer) for internet
access, SSH, and file transfer—the recommended next step.

## Connecting from your computer

### Two ways to connect

- What the CLI and Tailcat each give you, and why you would choose one or both

### Through the CLI

- Requirements, browser permission, connecting, connection status, and
  disconnecting
- CLI invocation, prompt controls, how long the connection lasts, and version
  information
- CLI options: browser opening, lab origin, listener port, wait, and logging
- What the connection carries: package repositories, the internet and what it
  does not carry, and local network access
- SSH from the CLI prompt or your own OpenSSH client
- SSH configuration, credentials, the guest's in-memory SSH server, and
  independence from the virtual network
- File transfer with `scp` and `rsync`
- Port forwarding

### Through Tailcat

- Connecting via SSH without the CLI: **Share via SSH** in a machine's
  Configuration window, your public key, and the `tailcat ssh` command
- How long it lasts: until you stop it, reboot the guest, or reload the tab

## The desktop

- Rack manager, machine details, and Topology
- Consoles, additional shells, active and named sessions, and session lifetime
- Console focus, the main pane, and maximization
- Window arrangement, minimization, and reopening
- Notes

## Commands and the command bar

- Lab Commands and shell commands
- Command syntax, arguments, options, escaping, and `--` passthrough
- Host-shell quoting when invoking the CLI
- Machine names, lists, patterns, state-dependent eligibility, and skipped
  targets
- Machine, shell-session, interface, switch, and port names
- The command bar: keyboard interaction, recent commands, completion,
  corrections, and previews
- Help by command or MCP tool name, results, confirmations, and cancellation
- Command availability in the command bar, CLI, and agent interfaces

Individual commands are described with their subjects and listed in the index.
This chapter defines the shared command language and command bar behavior.

## Machines

- Single and bulk machine creation
- Guest images (`alpine`, `debian`, and the `lab` image), machine names, and
  hostnames
- Software installation and package repositories
- Virtual CPUs, memory, machine inventory, status, and configuration
- Machine lifecycle: boot, reboot, power off, and completion or failure
  reporting
- Machine removal and disk deletion; removing a machine removes its checkpoints
  (see Storage and checkpoints)

## Storage and checkpoints

- Disk sizes at machine creation
- **Additional disks.** Describe adding disks during machine creation, their
  sizes, and their device names in the machine configuration. Each additional
  disk starts blank. Include a self-contained example of adding, identifying,
  formatting, and mounting a disk; keep general Linux storage administration
  outside this section.
- Browser storage and what survives a reload
- Disk checkpoints: scope, listing with `ls`, storage use, creation,
  restoration, and deletion

## Networks

### Interfaces and addressing

- Multiple interfaces and interface names
- Automatic and custom addresses, prefixes, and unconfigured interfaces
- Initial network attachment and isolated machines
- The package gateway, its relationship to switches, and what changes while the
  CLI is connected

### Switches and cables

- Switch creation, names, removal, and the default switch
- Ports, NIC cables, and inter-switch cables
- Plugging, moving, cutting, and unplugging cables
- Cable and port configuration lifetime
- Cable conditions: delay, loss, reordering, rate, MTU, and clearing them
- Topology, cable state, switch and cable counters, and drop reasons
- Loops, storms, and their reported state

### VLANs and spanning tree

- Access-port VLAN membership
- Trunks, allowed VLANs, native VLANs, and guest-interface restrictions
- Spanning-tree state, root selection, switch priority, port cost, and blocked
  ports
- Learned MAC addresses, VLAN association, aging, and flushing

### Packet capture

- Packet inspector and capture sources: switches and cables
- Capture-filter language
- Recording, pause/resume, clearing, buffer limits, and capture lifetime
- Frame details, ports, VLAN tags, events, and drops
- Decoded frame reads through the agent interface
- `.pcap` export scope, output destination, and interface differences

## Automation and agents

- MCP and WebMCP interfaces
- MCP tool availability, arguments, and results
- Operation acceptance versus completion, waiting, and failure reporting
- MCP tool policies (run, ask me, off), pause tools, and calls this session
- Agent-policy scope and direct CLI access
- Noninteractive command invocation, confirmations, JSON output, and exit status
- Guest execution targets, busy sessions, skipped targets, completion, and
  cancellation
- Terminal output, rendered-screen reads, and guest-origin data
- Guest file replacement, exact text, ownership, permissions, and size limits

Write this chapter last: the approvals UI may change.

## Troubleshooting

- The lab is open in another tab
- A machine fails to boot or runs out of storage
- A file, machine, or shell is missing after returning to the lab
- A package repository or public website is unreachable
- The CLI fails to connect, SSH fails, or a forwarded port is unreachable
- An agent cannot see or use an MCP tool
- A command skips a machine, finds a busy shell, or reports changed state
- Traffic loops, unexpected drops, or an empty or unexpected capture export

## Appendices and index

- Resource limits
- CLI configuration files and environment variables
- Index
