# Phase 2 stories

Copied from https://claude.ai/artifact/VMEenCKbRgoVGt55sDNWHL#2ab073a8-b7ec. The table at the end maps each box to its tests.

The limits are 16 machines and eight switches of eight ports.

## The gate

### 0. A scenario page becomes a topology

As an agent, I can turn a page of markdown into three subnets joined by two routers, using commands alone.

- [ ] One recorded set of commands builds three subnets, two routers, a VLAN trunk between two switches and one cable that loses frames.
- [ ] A ping between machines on the first and third subnets crosses both routers, the trunk and the lossy cable.
- [ ] With the loss set to zero, every ping is answered. With it set to 100%, none is.
- [ ] A reload brings the whole topology back, and the ping crosses it again.
- [ ] **Live run:** an agent given only the page, the lab's tools and `help` builds the same lab, and the person's only clicks are approvals.

## Commands

### 1.1 The phase 1 rules hold

As an agent, I can use every phase 2 capability the way I use the phase 1 ones.

- [ ] Each has a command-bar verb or option and an agent tool, run through the same parser. Looking at the topology view is the only exception.
- [ ] `help`, the tool descriptions and the input schemas cover each one and agree.
- [ ] A command that cannot run answers with one sentence naming the argument at fault and what would work.
- [ ] Nothing needs a click, a form or a follow-up command to take effect.

### 1.2 The lab describes its topology

As an agent, I can read the whole topology with one command, so that I can check what I built.

- [ ] One command lists every switch, every port, what is cabled to it, and each cable's state and conditions.
- [ ] It shows each port's VLAN setting, and its spanning tree state when that is on.
- [ ] The agent tool returns the same as structured data.

## Switches and cables

### 2.1 More than one switch

As an agent, I can add and remove switches, so that a scenario has separate segments.

- [ ] One command adds a switch, with a name the scenario chooses or the next free `switch<n>`.
- [ ] A name a machine or switch already has is refused. A ninth switch is refused with the limit.
- [ ] A broadcast on one switch does not reach a machine on another that no cable joins.
- [ ] Each switch has its own MAC table and counters, and the person can see any of them.
- [ ] Removing a switch asks once, lists what is plugged into it, and leaves those NICs and cables unplugged. `switch0` cannot be removed.

### 2.2 A NIC on any switch

As an agent, I can choose the switch each NIC is plugged into, so that a router joins two segments.

- [ ] A spawn option sets the switch, or none, for each NIC.
- [ ] One command moves a NIC's cable to another switch, with or without naming the port. The machine keeps running.
- [ ] With forwarding on, a two-NIC machine carries a ping between machines on two switches.
- [ ] The package gateway works for a machine whose `eth0` is on any switch, and `--no-gateway` still leaves it out.
- [ ] A full switch or a taken port is refused in a sentence that names it.

### 2.3 Cables between switches

As an agent, I can cable two switches together, so that a segment spans both.

- [ ] One command joins two switches and takes a port on each. Another removes the cable.
- [ ] Machines on either side ping each other, and each switch learns the far machine on its cable's port.
- [ ] The cable can be cut and reconnected, which flushes what both switches learned over it.
- [ ] Two switches can have more than one cable between them.

### 2.4 A loop is safe to make

As a person, I can cause a broadcast storm and watch it, so that I learn what a loop does.

- [ ] Closing a loop is allowed. One broadcast then circulates until something breaks the loop.
- [ ] The switches involved are marked as storming, with the rate of frames they carry.
- [ ] While it storms, a lab command still runs within a second, and no machine or page crashes.
- [ ] Frames the lab drops to stay responsive are counted and shown.
- [ ] Cutting one cable of the loop ends the storm within a second, and pings work again.

## Seeing the network

### 3.1 Capture by switch or cable

As a person, I can follow a packet across the topology, or look at one place in it.

- [ ] Each captured frame says which switch carried it, and by which ports it came and went.
- [ ] The filter takes a switch, or one cable, beside the terms it takes today.
- [ ] A ping across two routers shows every hop in order.
- [ ] The agent's capture tool takes the same filter.
- [ ] A capture narrowed to one cable saves as a `.pcap` that holds each frame once. Today it saves everything.

### 3.2 A topology view

As a person, I can see how the lab is wired.

- [ ] A view shows every switch, machine and cable, and which NIC each cable goes to.
- [ ] It follows each command without a reload: moved, cut and impaired cables, VLANs, storms and blocked ports.
- [ ] With 16 machines and eight switches, every name can be read.
- [ ] It can be used by keyboard, and does not rely on color alone.

## VLANs

### 4.1 Access ports

As an agent, I can put a switch port in a VLAN, so that one switch holds several segments.

- [ ] One command sets a port, named by its number or by the NIC on it, to a VLAN ID from 1 to 4094. A new port is in VLAN 1.
- [ ] Broadcasts and unknown frames stay within their VLAN, and addresses are learned per VLAN.
- [ ] Two machines in one subnet but in different VLANs cannot ping each other. Put in one VLAN, they can.
- [ ] The machine sends and receives ordinary untagged frames.

### 4.2 Trunks

As an agent, I can carry several VLANs over one cable between switches.

- [ ] One command makes a port a trunk, with the VLANs it allows and its native VLAN.
- [ ] Two VLANs cross one trunk, and each machine reaches only those in its own.
- [ ] The capture of the trunk shows each frame's 802.1Q tag, and the filter takes a VLAN ID.
- [ ] A VLAN the trunk does not allow does not cross it.
- [ ] Ends with different native VLANs behave as real switches do: untagged frames change VLAN.

## Link conditions

### 5.1 A bad cable

As an agent, I can give any cable delay, loss, reordering, a rate and an MTU, so that a scenario can have a poor link.

- [ ] One command sets any of them on a NIC's cable or a cable between switches, and clears them. It acts on both directions, without a reboot.
- [ ] 100 ms of delay adds about 200 ms to a ping's round trip.
- [ ] With 20% loss, the share of frames lost over 1,000 is within three points of it.
- [ ] With reordering, packets arrive in a different order and the capture shows it.
- [ ] With a rate of 1 Mbit/s, a TCP transfer runs within 20% of it. Frames beyond a bounded queue are dropped.
- [ ] A frame larger than the cable's MTU is dropped, and smaller ones pass.

### 5.2 The cause is visible

As a person, I can see that the cable did it.

- [ ] A frame the cable drops is in the capture with the reason: loss, rate or MTU.
- [ ] Each cable counts what it delivered and what it dropped, by reason.
- [ ] Conditions are shown where the cable is shown, and in the list of 1.2.

## Scale

### 6.1 Sixteen machines

As an agent, I can make up to 16 machines, so that a realistic topology fits.

- [ ] Sixteen Alpine machines of 256 MiB across two or more switches reach ready in CI, and each pings the others in its subnet. CI records the time and memory it took.
- [ ] A seventeenth is refused with the limit.
- [ ] The lab shows the memory its machines have been given.
- [ ] A machine the browser has no memory for fails with a sentence naming memory, and the others keep running.
- [ ] With 16 machines, the rail, the panes and the capture still tell each one apart.

## Spanning tree

These two come late in the phase, after VLANs and link conditions.

### 7.1 A loop without a storm

As an agent, I can turn spanning tree on, so that a scenario can have redundant cables.

- [ ] One command turns it on or off per switch. It is off on a new switch, so a loop storms as in 2.4.
- [ ] In a triangle of switches with it on, one port blocks, a broadcast reaches each machine once, and pings work.
- [ ] Cutting a cable in use brings the blocked port into use, and pings resume within the time the protocol's timers allow.
- [ ] Turning it on during a storm ends the storm.
- [ ] A cable to a switch with it off can still make a loop, and that loop still storms.

### 7.2 The election is visible and can be steered

As a person, I can see why a port is blocked, and change which one is.

- [ ] The switches exchange real BPDUs. The capture decodes their root, cost and port, and tcpdump in a guest sees them.
- [ ] Each switch shows the root, its own bridge ID, and each port's role and state.
- [ ] One command sets a switch's priority, and another a port's cost. Either can change the root or the blocked port.
- [ ] One tree covers every VLAN, and works across trunks.

## Keeping what exists

### 8.1 A reload brings the topology back

As a person, I can reload the page and find the network as it was.

- [ ] Switches, names, cables, VLANs, conditions and spanning tree settings return. MAC tables and counters start empty.
- [ ] A lab saved before phase 2 opens as one `switch0` with its machines, ports and cables unchanged, even when one of its machines is named `switch1`.

### 8.2 Defaults do not change

As a person who used unLAB before phase 2, I find that what I knew still works.

- [ ] `spawn 2 alpine`, today's `--net` values and the README's first-ping walkthrough behave as they do now.
- [ ] A lab with one switch looks as it does now: nobody needs to learn about switches or VLANs to ping.
- [ ] The existing unit, browser, integration and end-to-end suites pass.

## Build order

Stories 1.1, 1.2, 8.1 and 8.2 are met a part at a time, with each step.

1. Spike frame delivery, the first two decisions below.
2. Replace the one switch with named switches, changing nothing a person sees. Carry saved labs over (8.1).
3. Switches, and a NIC on any of them (2.1, 2.2).
4. Capture by switch (3.1).
5. Cables between switches, and loops (2.3, 2.4). Capture by cable (3.1).
6. Topology view (3.2). Later steps add to it.
7. Access ports and trunks (4.1, 4.2).
8. Link conditions (5.1, 5.2).
9. Sixteen machines (6.1).
10. Spanning tree (7.1, 7.2).
11. The gate (0).

## Decisions these stories wait on

| Decision | Why it blocks | Stories |
| --- | --- | --- |
| How frames are queued | A switch now delivers inside the call that received the frame, so a loop would recurse. Delay and rate need a queue too, and one design should serve all three | 2.3, 2.4, 5.1 |
| What clock delays run on | Browsers slow a page's timers while its tab is hidden, which would stretch delays and spanning tree timers. The switch may have to run in a worker | 5.1, 7.1 |
| What address a NIC on a new switch gets by default | If every switch defaults to `10.88.0.x`, names resolve to machines that cannot be reached. Proposed: `eth0` keeps it on any switch, and scenarios choose their own | 2.2, 8.2 |
| How a port or cable is named in a command | `port:2` in the filter means one port today, and would name one on every switch | 2.2, 2.3, 3.1, 4.1, 5.1 |
| Whether 16 machines fit | 16 at 256 MiB is 4 GiB of guest memory, not yet measured in a browser or on the CI runner | 6.1 |
| Which spanning tree protocol | Classic 802.1D takes 30 to 50 seconds to recover, rapid (RSTP) a few. Proposed: RSTP | 7.1, 7.2 |

## Left out on purpose

- VLAN interfaces inside a guest, which need the phase 3 kernel. Until then a router takes one NIC per VLAN, and trunks run between switches.
- A spanning tree per VLAN, and protections such as BPDU guard.
- A cable straight from one machine to another. A switch with two ports in use does the same.
- Conditions that differ by direction or change over time.
- Link aggregation, port mirroring and routing on a switch.
- Switches with more or fewer than eight ports.
- IPv6, which is phase 3.

## Evidence

| Story | Box | Test |
| --- | --- | --- |
