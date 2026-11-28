# <https://unlab.run> documentation

<https://unlab.run> gives you a network of Linux machines to experiment with.

## Language

### Documentation

**Manual**

The subject-based reference describing <https://unlab.run> and its controls, commands, and behavior. Getting started provides a short guided sequence for first-time users; the reference chapters stand independently, without requiring state carried over from that sequence.

**Exercises**

The collection of exercises that use <https://unlab.run> to teach concepts. An exercise gives the reader something to investigate, such as how traffic moves between two switches, and asks them to explain what they observe.
_Avoid_: Lab Workbook, labs, lessons

### The lab

**Lab**

The place where your machines, switches, cables, and disks live, kept with the desktop layout in one browser profile, in the sense of a home lab. You open one lab at a time.
_Avoid_: lab (for an exercise you work through), workspace, project, session

**Exercise**

One investigation in the Exercises, worked through in the lab.
_Avoid_: lab, lesson, scenario

### Machines

**Machine**

A computer in the lab that you create, boot, cable to switches, and remove.
_Avoid_: node, VM, host

**Guest**

The Linux system running inside a machine: its files, shells, and packages. Say "guest" only when you mean the inside of a machine rather than the lab's controls for it.
_Avoid_: node, OS

**Package gateway**

The route a machine's first interface can use to reach package repositories, and the internet while the CLI is linked.
_Avoid_: default gateway

### Cables

**Plug / cut**

You plug a machine into a switch with a cable, and cut the cable to break it. A plugged cable is up; a cut cable is down. "Connect" is fine in ordinary prose; use "plug" for the action.
_Avoid_: link (as a noun for a cable)

**Cable condition**

A setting that changes how a cable carries frames: delay, loss, reordering, rate, or MTU.
_Avoid_: impairment, link condition

### Commands and the CLI

**Command bar**

The place in the lab where you type Lab Commands.
_Avoid_: command palette

**Lab Command**

An instruction to the lab, such as `spawn`, `link`, or `capture`, typed in the command bar or at the CLI prompt, or sent by an agent. In the Manual, "command" alone means a Lab Command.

**Shell command**

A command run inside a guest.
_Avoid_: guest command, command (unqualified)

**MCP tool**

An operation an agent calls through MCP or WebMCP.
_Avoid_: tool (unqualified), function, action

**CLI connection**

The joining of the CLI on your computer to the lab in your browser, through which machines reach your computer and the internet. The CLI is connected or disconnected.
_Avoid_: link, linked (link is a networking term)
