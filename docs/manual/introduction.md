# Introduction

On <https://unlab.run> you can boot Linux machines in a browser tab and build a
network with virtual switches and cables.

## The lab

Open **Rack manager** to [create machines](machines.md#machine-creation),
[change their power state](machines.md#power-states), and
[plug them into switches](networks.md#patching-a-machine-interface). Open
**Topology** from the lab menu to see which machines share a switch.

You can run Alpine or Debian on a machine. Open its terminal to work on files or
install software. With a [package gateway](networks.md#package-gateway), a
machine can download packages from its configured repositories through the
browser.

With the default settings, two machines get addresses on the same switch. You
can ping one from the other. To carry traffic between two switches, join them
with a cable.

When you reopen the lab in the same browser profile, you get back your desktop
layout, your network, and the files you saved on each machine's disk.

## Connections from your computer

Connect the command-line interface (CLI) on your computer when you want to copy
files to or from a machine or open its shell over SSH (Secure Shell). While the
CLI is connected, machines with a package gateway can also reach public websites
through your computer.

To give someone on another computer SSH access to one machine, share it through
[Tailcat](connecting-from-your-computer.md#ssh-through-tailcat).

## The Manual and the Exercises

For a first run, [boot two machines and send a ping](getting-started.md). Use
the [Manual's index](index-of-terms.md) to look up a control or command.

The [Exercises](../exercises/) give you questions to investigate. In
[Connect two switches](../exercises/connect-two-switches.md), you move one
machine to a second switch and watch which ports carry the ping and its reply.

## Conventions

Bold text shows the words you see on screen. Select the logo at the top left of
the desktop to open the lab menu.

Enter commands in the
[command bar](commands-and-the-command-bar.md#command-bar-keys) at the top of
the desktop or at the CLI prompt. Enter shell commands in the machine's
terminal.

The Manual uses monospace for what you type, command output, and names such as
`switch0`. Key names such as Enter appear in ordinary text.

Each command entry starts with a synopsis showing which arguments you can use.

| Notation       | How to read it                                               |
| -------------- | ------------------------------------------------------------ |
| `<machine>`    | Supply a machine name. Leave out the angle brackets.         |
| `[name]`       | A name is optional. Leave out the square brackets.           |
| `up \| down`   | Type one of the two words. Leave out the bar.                |
| `-- <command>` | Type the two hyphens, a space, and the shell command to run. |
