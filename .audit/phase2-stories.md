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
| 8.1 | A lab saved before phase 2 opens as one `switch0` | `e2e/saved-labs.spec.ts`: a lab saved before there were several switches opens on one, with a machine called switch1 as it was |
| 8.1 | A lab saved before phase 2 opens as one `switch0`, from each version | `src/commands/saved-labs.test.ts`: version %i opens as one switch0, with its machines, ports, cuts and names as they were |
| 8.2 | `spawn 2 alpine`, today's `--net` values and the README's first ping | `e2e/first-run.spec.ts`: a first visit boots two alpine machines, pings the peer and restores the lab on reload; `e2e/network.spec.ts`: pings show in the dock; cutting a cable by its port floods, flushes and reconnects; `e2e/nics.spec.ts`: a NIC left unplugged takes no port, and a machine that needs more ports than are free is refused |
| 8.2 | A lab with one switch looks as it does now, for named switches | `src/ui/switch/switch.browser.test.ts`: reads switch0, its subnet and the link count in its header; `src/ui/rail/rail.browser.test.ts`: names switch0 at its foot while there is no dock, and drops it once a machine exists; `.audit/phase2/surface.mjs` on 24c38d9 and on this slice prints the same |
| 2.1 | One command adds a switch, with a chosen name or the next free `switch<n>` | `e2e/switches.spec.ts`: a switch is added by a chosen name or the next free one, and a taken name and a ninth are refused |
| 2.1 | A name a machine or switch already has is refused. A ninth switch is refused with the limit | the same test |
| 2.1 | A broadcast on one switch does not reach a machine on another that no cable joins | `e2e/switches.spec.ts`: a broadcast stays on its switch, and each switch has its own MAC table and counters to look at |
| 2.1 | Each switch has its own MAC table and counters, and the person can see any of them | the same test, and by keyboard and with axe in `src/ui/switch/switch.browser.test.ts`: chooses in its title which one it shows, by keyboard; counts the frames of the one it shows, and has its MAC table beside it; passes axe |
| 2.1 | Removing a switch asks once, lists what is plugged into it, and leaves those NICs unplugged. `switch0` cannot be removed. Cables between switches come with 2.3 | `e2e/switches.spec.ts`: a switch asks before it goes, unplugs what is in it, and leaves the machines running; the refusal of `switch0` in: a switch is added by a chosen name or the next free one, and a taken name and a ninth are refused |
| 2.2 | A spawn option sets the switch, or none, for each NIC | `e2e/switches.spec.ts`: each NIC goes on the switch that spawn names, or on none |
| 1.1 | Each has a verb or option and an agent tool, through the same parser, for switches | `e2e/help.spec.ts`: help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent; `e2e/switches.spec.ts`: a switch is added by a chosen name or the next free one, and a taken name and a ninth are refused |
| 1.1 | `help`, the tool descriptions and the input schemas agree, for switches | `e2e/help.spec.ts`: help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent |
| 1.1 | A command that cannot run answers with one sentence, for switches | `e2e/help.spec.ts`: what cannot run is refused in one sentence, the same in the bar and through WebMCP; `e2e/switches.spec.ts`: a switch is added by a chosen name or the next free one, and a taken name and a ninth are refused; `src/commands/refusals.test.ts` |
| 1.1 | Nothing needs a click, a form or a follow-up command, for switches | `e2e/switches.spec.ts`: a switch is added by a chosen name or the next free one, and a taken name and a ninth are refused; each NIC goes on the switch that spawn names, or on none |
| 1.2 | One command lists every switch, every port, what is cabled to it, and each cable's state. Conditions come with 5.1 | `e2e/switches.spec.ts`: each NIC goes on the switch that spawn names, or on none; `src/commands/verbs/switches.test.ts`: lists every switch and port, what is in it and its link, and what is in none |
| 1.2 | The agent tool returns the same as structured data | the same two tests |
| 8.1 | Switches and their names return, with their cables. MAC tables and counters start empty. The rest of the box comes with its stories | `e2e/switches.spec.ts`: a reload brings back every switch and what was plugged in, with tables and counters empty |
| 8.2 | A lab with one switch looks as it does now, once switches can be added | `src/ui/switch/switch.browser.test.ts`: shows switch0 again when the one it showed is removed, and is as it was when no other is left; `.audit/phase2/surface.mjs` on 36af9df and on this slice differs, up to its labs of several switches, only in help, tool descriptions and the new verbs and tools |
| 2.2 | One command moves a NIC's cable to another switch, with or without naming the port. The machine keeps running | `e2e/cables.spec.ts`: a cable moves to another switch, at its lowest free port or one that is named, and the machine runs on; `src/commands/verbs/plug.test.ts` |
| 2.2 | With forwarding on, a two-NIC machine carries a ping between machines on two switches | `e2e/cables.spec.ts`: a machine with a NIC on each of two switches forwards a ping between them, and the capture has it on both |
| 2.2 | The package gateway works for a machine whose `eth0` is on any switch, and `--no-gateway` still leaves it out. On Alpine. Debian's mirror refuses the lab | `e2e/cables.spec.ts`: the package gateway works on any switch that eth0 is on, and --no-gateway still leaves it out |
| 2.2 | A full switch or a taken port is refused in a sentence that names it | `e2e/cables.spec.ts`: a full switch, a taken port and all else that cannot be plugged is refused by name; `src/commands/refusals.test.ts` |
| 1.1 | Each has a verb or option and an agent tool, through the same parser, for cables | `e2e/cables.spec.ts`: a cable moves to another switch, at its lowest free port or one that is named, and the machine runs on; `e2e/help.spec.ts`: help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent |
| 1.1 | `help`, the tool descriptions and the input schemas agree, for cables | `e2e/help.spec.ts`: help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent; the bar completes and previews each verb and option as it does spawn |
| 1.1 | A command that cannot run answers with one sentence, for cables | `e2e/cables.spec.ts`: a full switch, a taken port and all else that cannot be plugged is refused by name; `e2e/help.spec.ts`: what cannot run is refused in one sentence, the same in the bar and through WebMCP |
| 1.1 | Nothing needs a click, a form or a follow-up command, for cables. A cut cable that is moved stays cut, as it would where it was | `e2e/cables.spec.ts`: a cable moves to another switch, at its lowest free port or one that is named, and the machine runs on |
| 1.2 | The list and the tool follow a cable that is moved, cut or unplugged | `e2e/cables.spec.ts`: every test reads it with `topology_read` |
| 8.1 | Cables that were moved or unplugged return, with a reboot, a restore and a boot after a failure too | `e2e/cables.spec.ts`: a moved or unplugged cable is where a reload, a reboot, a restore and a boot after a failure find it; a NIC that link up plugged in stays plugged in when its machine fails and boots; `src/model/switches.test.ts`: opens a lab whose plugged NIC was saved with no network on the switch that it is in, for its later boots |
| 8.2 | A lab with one switch is as it was, once cables can move | `.audit/phase2/surface.mjs` on 81bc741 and on this slice differs, up to its labs of several switches, only in help and tool descriptions, the new verbs and tools, the part that a refused `--net` list names, and a failed machine whose NIC `link up` had plugged in, which now boots plugged in |
| 3.1 | Each captured frame says which switch carried it, and by which ports it came and went. A lab of one switch says neither in its rows, as before, and the port in the frame's detail | `e2e/capture.spec.ts`: a ping across two routers is captured at every hop in order, each with its switch and ports |
| 3.1 | The filter takes a switch, or one cable, beside the terms it takes today. A cable between switches comes with 2.3 | `e2e/capture.spec.ts`: a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read; `src/net/filter.test.ts`; `src/capture/follow.test.ts` |
| 3.1 | A ping across two routers shows every hop in order, on three switches, for rows of one time too | `e2e/capture.spec.ts`: a ping across two routers is captured at every hop in order, each with its switch and ports; `src/capture/log.test.ts`: are in the order that they carried the frames, which can all have one time |
| 3.1 | The agent's capture tool takes the same filter | `e2e/capture.spec.ts`: a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read |
| 3.1 | A capture narrowed to one cable saves as a `.pcap` that holds each frame once. A cable between switches comes with 2.3 | `e2e/capture.spec.ts`: a capture narrowed to one cable saves each of its frames once, and any other saves everything |
| 1.1 | Each has a verb or option and an agent tool, through the same parser, for capture by switch and cable: `capture` and `capture_read` take one filter. The file is the person's download, and `capture_read` reads the frames in it | `e2e/capture.spec.ts`: a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read; a capture narrowed to one cable saves each of its frames once, and any other saves everything |
| 1.1 | `help`, the tool descriptions and the input schemas agree, for capture by switch and cable | `e2e/capture.spec.ts`: a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read; `e2e/help.spec.ts`: the bar completes and previews each verb and option as it does spawn |
| 1.1 | A command that cannot run answers with one sentence, for capture by switch and cable | `e2e/capture.spec.ts`: a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read |
| 1.1 | Nothing needs a click, a form or a follow-up command, for capture by switch and cable, but for saving a file | `e2e/capture.spec.ts`: a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read |
| 8.2 | A lab with one switch is as it was, once the capture filters by switch and cable | `.audit/phase2/surface.mjs` on 90ed9f5 and on this slice differs, up to its labs of several switches, only in `capture`'s help and `capture_read`'s description and schema, the completions of a filter, the term that a refused filter marks, and `switch0` and `switch0:2`, which a filter now reads; `src/ui/capture/capture.browser.test.ts`: has no such column in a lab of one, unless a switch that is gone carried something |
| 2.4 | While it storms, no page crashes: the capture's open ARP requests, which the spike found. The rest comes with 2.4 | `src/capture/log.test.ts`: keeps no request that has left the buffer; grows with neither the questions nor the replies |
| 2.3 | One command joins two switches and takes a port on each. Another removes the cable | `e2e/switch-cables.spec.ts`: a cable joins two switches at the lowest free ports or those that are named, their machines ping each other, and another command removes it; `src/commands/verbs/cable.test.ts`; `src/model/cables.test.ts` |
| 2.3 | Machines on either side ping each other, and each switch learns the far machine on its cable's port | the same e2e test, by each switch's MAC table on the page; `test/integration/switch-cables.test.ts`: machines on two switches that a cable joins ping each other, each switch learns the far one on the cable's port, and a cut flushes both |
| 2.3 | The cable can be cut and reconnected, which flushes what both switches learned over it | `e2e/switch-cables.spec.ts`: a cable between switches is cut and reconnected, which flushes what both learned over it, and a second one carries meanwhile; the same integration test, cut at one end and reconnected at the other |
| 2.3 | Two switches can have more than one cable between them | the same e2e test: a second cable is listed beside the first, which is cut, and carries the ping; both up are a loop, as 2.4 has it; `src/runtime/fabric.test.ts`: can be one of several between the same two switches, and can have both its ends in one |
| 2.4 | Closing a loop is allowed. One broadcast then circulates until something breaks the loop | `e2e/switch-cables.spec.ts`: closing a loop is allowed: one broadcast then goes round, the switches are marked as storming with their rate, the lab still answers, and a cut ends it within a second; `test/integration/switch-cables.test.ts`: one broadcast goes round a loop of three switches until a cable is cut, the machines answer meanwhile, and pings work a second after |
| 2.4 | The switches involved are marked as storming, with the rate of frames they carry. Every switch that looped frames come into is marked, one beyond the loop too | the same e2e test: `topology_read`, the `topology` report, the faceplate, the chooser and the capture's rows; `src/runtime/fabric.test.ts`: makes every switch that looped frames come into storm, with their rate: those on the loop, and one beyond it |
| 2.4 | While it storms, a lab command still runs within a second, and no machine or page crashes | the same e2e test: `machines_list` three times, `ls` typed, and `echo` in each machine, each under a second, with no page error; `e2e/switch-cables.spec.ts`: a mesh of four switches storms until every loop is cut, and what the lab drops to stay responsive is counted and shown; a reload brings back the cables between switches, cut or not, with tables and storms empty, and a lab that was saved with a loop opens and answers; `src/ui/capture/capture.browser.test.ts`: has no more nodes in its dock list after them than before, which the list of 961d670 fails, and which is what kept the page's thread busy as a storm went on; 60 s of each storm measured in `.audit/phase2/cables/results/` |
| 2.4 | Frames the lab drops to stay responsive are counted and shown | `e2e/switch-cables.spec.ts`: a mesh of four switches storms until every loop is cut, and what the lab drops to stay responsive is counted and shown: in `topology_read`, on the faceplate while it storms, and in the capture's row of each storm's end; `test/integration/switch-cables.test.ts`: a mesh of four switches drops what does not fit and counts it, storms on while any loop is whole, and ends when the last is cut |
| 2.4 | Cutting one cable of the loop ends the storm within a second, and pings work again. True of one loop: a mesh storms on until every loop is cut | `e2e/switch-cables.spec.ts`: closing a loop is allowed: …, on a triangle; a mesh of four switches storms until every loop is cut, …, where one cut leaves the storm and the cuts that leave a star end it within a second; both integration tests of loops |
| 2.1 | Removing a switch asks once, lists what is plugged into it, and leaves those NICs and cables unplugged, for cables between switches | `e2e/switch-cables.spec.ts`: a switch that is removed takes its cables to other switches with it, after asking once with each of them listed; `src/commands/verbs/cable.test.ts`: rmswitch, for a switch with cables to others |
| 3.1 | Each captured frame says which switch carried it, and by which ports it came and went, across a cable between switches | `e2e/switch-cables.spec.ts`: a cable between switches is filtered by either of its ports, saves each frame once, and its event rows name both ends |
| 3.1 | The filter takes a switch, or one cable, beside the terms it takes today, for a cable between switches: either of its ports names it, and shows the same frames as the switch at that end carried them | the same test; `src/capture/cables.test.ts` |
| 3.1 | The agent's capture tool takes the same filter, for a cable between switches | the same test, which reads both ends with `capture_read` |
| 3.1 | A capture narrowed to one cable saves as a `.pcap` that holds each frame once, for a cable between switches | the same test, from each end |
| 1.1 | Each has a verb or option and an agent tool, through the same parser, for cables between switches: `cable` and `switch_cable`, `uncable` and `switch_uncable`, `link` and `link_set`, `rmswitch` and `switch_remove` | `e2e/switch-cables.spec.ts`: the first, second and fourth tests run each from the bar and from its tool; `e2e/help.spec.ts`: help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent |
| 1.1 | `help`, the tool descriptions and the input schemas agree, for cables between switches | `e2e/help.spec.ts`: help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent; the bar completes and previews each verb and option as it does spawn; `e2e/switch-cables.spec.ts`: what cannot be cabled is refused in one sentence, the same in the bar and through WebMCP, and the bar completes and previews it |
| 1.1 | A command that cannot run answers with one sentence, for cables between switches | `e2e/switch-cables.spec.ts`: what cannot be cabled is refused in one sentence, the same in the bar and through WebMCP, and the bar completes and previews it; `src/commands/verbs/cable.test.ts`; `src/commands/refusals.test.ts` |
| 1.1 | Nothing needs a click, a form or a follow-up command, for cables between switches | `e2e/switch-cables.spec.ts`: a cable joins two switches …, where the line after `cable` is the ping; closing a loop is allowed: … |
| 1.2 | One command lists every switch, every port, what is cabled to it, and each cable's state, for cables between switches and for storms | `e2e/switch-cables.spec.ts`: every test reads it with `topology_read`, and the storm test reads the `topology` report too; `src/commands/verbs/cable.test.ts`: topology, with cables between switches |
| 1.2 | The agent tool returns the same as structured data, for cables between switches and for storms | the same tests |
| 8.1 | Switches, names and cables return, for cables between switches and their cuts. MAC tables and storms start empty, and a lab saved with a loop opens | `e2e/switch-cables.spec.ts`: a reload brings back the cables between switches, cut or not, with tables and storms empty, and a lab that was saved with a loop opens and answers; `src/model/cables.test.ts`: a saved lab; `src/commands/saved-labs.test.ts`: version 7 opens with its switches and what was plugged into each, and has no such cable |
| 8.2 | A lab with one switch is as it was, once switches can be cabled | `.audit/phase2/surface.mjs` on 961d670 and on this slice differs, in its labs of one switch and of several, only in the help, manuals and tool descriptions of `link`, `mkswitch`, `rmswitch` and `topology`, the new verbs and tools, and `link down switch0`, which now says that switch0 is a switch and names its ports; TCP between two guests on one switch, in `.audit/phase2/cables/results/` |
| 2.3 | One command joins two switches, and the cable can be cut and removed, on the desktop: Topology draws it, up or cut, and counts its ports. Rack manager names its far end, cuts it with `link`, removes it with `uncable`, and offers its port to no patch | `e2e/desktop-cables.spec.ts`: the desktop draws a cable between switches, cuts and removes it from the switch's ports, and shows a storm until its loop is cut. Each assert was seen red, with soft asserts, under one of four breaks: Topology drawing no cable and counting only machines' ports; Rack manager counting and labelling only machines' ports, and the patch form offering a cabled port; the port table drawing a cabled port as before; `link` and `uncable` given the far switch's name, which they refuse |
| 2.4 | The switches involved are marked as storming, with the rate of frames they carry, on the desktop: in Topology's node, in Rack manager's row, and in the switch's details with its looped frames a second and what it dropped. Cutting the loop's cable from its port ends it | the same test, on a cable from a switch to itself. Seen red with no storm in Topology's node, the row or the details, and with the cut given the far switch's name, which leaves the storm on |
| 4.1 | One command sets a port, named by its number or by the NIC on it, to a VLAN ID from 1 to 4094. A new port is in VLAN 1 | `src/commands/verbs/vlan.test.ts`: puts a port in a VLAN, named by its number or by the NIC in it, and says so; refuses in one sentence what it cannot set, with the argument at fault and what would do; `src/model/vlans.test.ts`: is 1 for a new port, and is set on a port that a NIC or a cable is in, which the switch is told; `e2e/vlans.spec.ts`: a port goes in a VLAN by its number or by its NIC, from the bar and its tool. Red under `.audit/phase2/vlans/breaks.mjs`: a VLAN ID can be 4095, a free port takes a VLAN, every port carries every VLAN (e2e) |
| 4.1 | Broadcasts and unknown frames stay within their VLAN, and addresses are learned per VLAN | `src/runtime/fabric.test.ts` VLANs: a new port is in VLAN 1, and a broadcast on an access port reaches only the ports of its VLAN; learns addresses per VLAN, so a frame for a machine of another VLAN is flooded in its own, and never reaches it; a port put in another VLAN forgets what the switch learned on it; `test/integration/vlans.test.ts`: the switch learns both in VLAN 10. Red: every port carries every VLAN, one table for every VLAN, a port keeps what was learned on it when its VLAN changes |
| 4.1 | Two machines in one subnet but in different VLANs cannot ping each other. Put in one VLAN, they can | `test/integration/vlans.test.ts`: two machines in one subnet but in different VLANs cannot ping each other, and in one VLAN they can, each with frames that have no tag; `e2e/vlans.spec.ts`: the same through the bar and `port_vlan`. Red: every port carries every VLAN (both) |
| 4.1 | The machine sends and receives ordinary untagged frames | the same integration test, by the tap and by the pings; `src/runtime/fabric.test.ts`: a trunk carries each VLAN tagged …, untagged to its machines; `e2e/vlans.spec.ts`: capture_read has them in VLAN 10, tagged nowhere. Red: an access port on a cable sends tagged |
| 4.1 | Storms per VLAN: a loop in one VLAN does not flood another round it | `src/runtime/fabric.test.ts`: a loop in one VLAN storms in that VLAN alone: a broadcast of another crosses once, and is not slowed. Red: every port carries every VLAN |
| 4.1 | A cable from a port in one VLAN to a port in another is crossed once, and only a loop storms and makes a switch forget, and then only the tables of the VLANs it looped in | `src/runtime/fabric.test.ts` VLANs: a frame that a cable between two ports of one switch, or a cable beside a trunk, takes into another VLAN crosses once, has not looped, and is not slowed; a loop that changes VLAN on the way round storms: one cable takes 10 to 20, and another takes 20 back to 10; a storm that ends forgets the tables of the VLANs it looped in, and keeps the others; `test/integration/vlans.test.ts`: a cable from a port in VLAN 10 to a port in VLAN 20 of one switch joins them, and pings cross it once, with no storm. Red: a frame has looped when it comes back to a switch in any VLAN (unit and integration), a storm that ends forgets every VLAN's table |
| 4.2 | One command makes a port a trunk, with the VLANs it allows and its native VLAN | `src/commands/verbs/vlan.test.ts` trunk: makes the port of a cable between switches a trunk, of every VLAN and native 1 unless told otherwise; says before it runs when its native VLAN is not allowed; refuses the port of a machine's NIC, whose kernel cannot read tags; `e2e/vlans.spec.ts`: two VLANs cross one trunk …, by the bar and `port_trunk`. Red: a NIC's port can be a trunk (unit and e2e) |
| 4.2 | A trunk whose native VLAN it does not allow says so before it runs and in what it returns, so an agent reads it too | `src/commands/verbs/vlan.test.ts` trunk: says before it runs, and in what it returns, when its native VLAN is not allowed, so nothing crosses it untagged. Red: a trunk's result says nothing of a native VLAN it does not allow |
| 4.2 | Two VLANs cross one trunk, and each machine reaches only those in its own | `test/integration/vlans.test.ts`: two VLANs cross one trunk, tagged, and each machine reaches only those in its own, until the trunk no longer allows one; `src/runtime/fabric.test.ts`: a trunk carries each VLAN tagged and its native one untagged …; puts the tag on the wire; `e2e/vlans.spec.ts`: two VLANs cross one trunk. Red: a trunk sends every VLAN untagged, every port carries every VLAN |
| 4.2 | The capture of the trunk shows each frame's 802.1Q tag, and the filter takes a VLAN ID | `src/capture/cables.test.ts`: the rows of frames in VLANs say which VLAN carried each, and on which ports it had its 802.1Q tag; are kept by a VLAN term; `src/net/filter.test.ts`: a VLAN term; `src/ui/capture/frame-detail-model.test.ts`: frameDetail of a frame in a VLAN; `e2e/vlans.spec.ts`: rows, frame detail and the cable's `.pcap`, each frame tagged 0x8100 with its VLAN. Red: a row says nothing of its tag, the VLAN term keeps every frame, the frame detail has no 802.1Q group, a port of another VLAN was down, a cable's file has each frame as it came in (e2e); and once for real: `capture switch0:8 icmp` saved untagged frames until 407d3c2 |
| 4.2 | The frame detail's bytes are as they were on the wire at the port it came in by, with the tag it had there | `src/ui/capture/frame-detail-model.test.ts` frameDetail of a frame in a VLAN: dumps the bytes as they were on the wire at the port it came in by, with the tag it had there. Red: the frame detail dumps a frame without the tag it came in with |
| 4.2 | A VLAN the trunk does not allow does not cross it | `src/runtime/fabric.test.ts`: a VLAN that a trunk does not allow does not cross it, whichever end leaves it out; a native VLAN that the trunk does not allow does not cross it untagged; the integration test of two VLANs, with `--allow 10`; `e2e/vlans.spec.ts`. Red: a trunk allows every VLAN |
| 4.2 | A trunk reads tags as real switches do: VLAN 0 gives only a priority, so the frame is in the native VLAN, and VLAN 4095 is reserved, so the frame is dropped | `src/runtime/fabric.test.ts` VLANs: a trunk takes a tag of VLAN 0, which gives only a priority, as no tag, and drops one of VLAN 4095, which is reserved. Red: a tag of VLAN 0 puts a frame in VLAN 0, a trunk carries VLAN 4095 |
| 4.2 | An access port takes a tagged frame only of its own VLAN, and takes the tag off, as most switches do. So a trunk cabled to an access port loops that VLAN at most, and no wiring makes a frame longer | `src/runtime/fabric.test.ts` VLANs: an access port takes a frame tagged with its own VLAN, or with VLAN 0, without the tag, and drops one tagged with another; a cable from a trunk to an access port of one switch, and of another switch, loops the port's VLAN with every frame as long as it was sent; `test/integration/vlans.test.ts`: a broadcast that loops from a trunk into an access port of one switch stays as long as it was sent, its storm ends at a cut, and pings work after it. Red: an access port takes a tagged frame as its VLAN's, tag and all (unit and integration). On the page, `.audit/phase2/vlans/tagged-loop.mjs`: at cfd20a2 the frame reached 219,714 bytes in 82 s, the page threw a RangeError, and no cable carried a ping again |
| 4.2 | A port drops and counts a frame longer than Ethernet carries: 1,514 bytes, or 1,518 with a tag | `src/runtime/fabric.test.ts` VLANs: a port takes a frame of up to 1,514 bytes, or 1,518 with its tag, and drops and counts a longer one. Red: a port takes a frame of any length |
| 2.4 | The lab stays usable: one frame that the fabric throws on does not stop the cables between switches | `src/runtime/pump.test.ts`: carries what waits, and what comes after, when the fabric has thrown, and lets what it threw reach whoever called. Red: the pump stays busy for good once the fabric has thrown. Once for real: at cfd20a2 a RangeError in `Fabric.drain` left every cable between switches dead until a reload, by `.audit/phase2/vlans/tagged-loop.mjs` |
| 2.4 | The lab stays usable: one broadcast costs no more at once than a flood for each switch and VLAN it reaches, however the lab is wired, and a lab with one way to each switch waits for nothing | `src/runtime/fabric.test.ts`: one broadcast into a mesh of six switches with a cable that joins two VLANs is carried at once to each switch in each VLAN, and no further until its turn; marks a frame as looped from where it comes back to a switch that it had left, which a copy that came into a switch after another does in its turn; frames that go by the table, and broadcasts, cross a cable from one VLAN to another, and the next cable, at once, however many there are. Red: every copy of a frame goes on at once until it has looped, every frame that came over a cable waits its turn. `.audit/phase2/vlans/results/fanout.txt`: 1,370 frames at once in a mesh of six with one join at 4f9aa89, 32,471 at cfd20a2, 51 now; `results/candidates.txt` has each rule that was tried |
| 4.2 | Ends with different native VLANs behave as real switches do: untagged frames change VLAN | `src/runtime/fabric.test.ts`: ends with different native VLANs move an untagged frame from one VLAN to the other; `test/integration/vlans.test.ts`: ends of a trunk with different native VLANs move untagged frames …; `e2e/vlans.spec.ts`. Red: an untagged frame on a trunk is in VLAN 1 |
| 1.1 | Each has a verb and an agent tool, through the same parser, for VLANs: `vlan` and `port_vlan`, `trunk` and `port_trunk`. `help`, descriptions and schemas agree, and refusals are one sentence | `src/commands/refusals.test.ts` (every verb runs its example from the bar and its tool, and refuses in one sentence); `src/commands/verbs/index.test.ts`; `src/agent/agent.test.ts`; `e2e/help.spec.ts`, `e2e/agent.spec.ts`; `e2e/vlans.spec.ts`: what cannot run is refused alike in the bar and through WebMCP |
| 1.2 | It shows each port's VLAN setting | `src/commands/verbs/switches.test.ts`: lists every switch and port, what is in it, its link and what it carries; `e2e/vlans.spec.ts`: every test reads it with `topology_read`. Red: topology says no VLAN |
| 8.1 | VLANs return on a reload. A lab saved at version 8 opens with every port in VLAN 1 | `src/model/vlans.test.ts` a saved lab; `src/commands/saved-labs.test.ts`: version 8 opens with its cables between switches, cut or not, and every port in VLAN 1 (`test/fixtures/saved-labs/version-8.json`, written by a7ed190); `e2e/vlans.spec.ts`: a reload brings it all back. Red: a saved lab has no VLANs, a reload does not tell the switches (unit and e2e), version 8 is not upgraded |
| 8.1 | A lab saved before VLANs, with a switch or a machine called `vlan`, opens, and `vlan` alone names it in the filter | `src/commands/saved-labs.test.ts`: version 8 opens with a switch called vlan, which a filter names by that word alone; version 8 opens with a machine called vlan, which a filter names by that word alone. Red: vlan is a word that nothing may be called (the switch), vlan alone never names a machine or a switch (both) |
| 8.2 | A lab in VLAN 1 looks as it does now, once ports have VLANs | `src/ui/switch/switch.browser.test.ts`: puts a port's VLAN on its cable's tag …, and the far end in VLAN 1 is as before; `e2e/vlans.spec.ts`: the desktop has no VLAN column until a port is not in VLAN 1; the existing suites pass. Red: the faceplate says nothing of a VLAN, the desktop has no VLAN column (e2e). TCP between two guests on one switch in `.audit/phase2/vlans/results/` |
