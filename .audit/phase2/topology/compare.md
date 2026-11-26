# Story 3.2 against the desktop's Topology window

The Topology window (`src/ui/desktop/topology.ts`, opened by `src/ui/desktop/desktop.ts`) is the view story 3.2 is
measured against. The classic layout is not.

## How it was seen

`look.mjs` drives the built app in Chromium at 1440 × 900 on the default desktop. It makes two switches, `switch0` and
`lan`, `node1` and `node2` on `switch0`, `router` with `eth0` on `switch0` and `eth1` on `lan`, and `node4` on `lan`.
Then it runs, one by one, `cable switch0 lan`, `plug node2 lan:5`, `link down router:eth1`, `link down switch0:4`,
`link up node1 --delay 50ms --loss 10%`, `vlan node4 10` with `trunk switch0:4 --allow 1,10`, `cable lan lan` with a
broadcast from `node4` (a storm), `uncable lan:6` (the storm ends) and `uncable switch0:4`. After each command it prints
every node's words, every line's two ends, state, stroke and dash, and what the node gives a screen reader. It marks the
page at the start and checks the mark after each step, so no step reloaded the page. Then it tabs through the window
from its title bar, presses an arrow key, and presses Enter on `router`.

- `results/before.txt` and `before/` are the app at 91cf6c3, before this slice.
- `results/after.txt` and `after/` are the app with this slice.
- `before/crowd*.png` and `after/crowd*.png` come from the browser test of 16 machines and eight switches, before and
  after, in the window as it opens and maximized.

## Box by box

| What 3.2 asks | At 91cf6c3 | Now | Evidence |
| --- | --- | --- | --- |
| Every switch, machine and cable is shown | Yes. Each switch and machine is a node. Each NIC's cable and each cable between switches is a line, a cable from a switch to itself a loop over it. | Unchanged | `results/before.txt`, every step; `before/02-cabled.png` |
| Which NIC each cable goes to | No. `router` had two lines and no word for either. No NIC name was in the window. | A machine with several NICs says where each goes in its note: `lab · eth0 switch0:3 · eth1 lan:2`. Every node describes its cables to a screen reader and in its title: `eth1 · to lan port 2 · up`. A machine with one NIC has a plain note, since its line can only be `eth0`. | `results/after.txt`; `after/01-wired.png` |
| A cable between switches, by its ports | No port number anywhere in the window. | In each switch's description and title: `Port 4 · to lan port 3 · up`. Not drawn. | `results/after.txt`, `cable switch0 lan` |
| Follows `cable`, `uncable` without a reload | Yes. The line comes and goes, and the switches' port counts change. | Unchanged, and the description follows. | `results/before.txt` and `results/after.txt`, `cable switch0 lan` and `uncable switch0:4` |
| Follows a moved cable (`plug`) | Yes. `node2`'s line moved from `switch0` to `lan`. | Unchanged, and the description follows: `eth0 · to lan port 5 · up`. | `before/03-moved.png` |
| Follows a cut cable (`link down`) | Yes. A NIC's cable and a cable between switches turn dashed and red. | Unchanged, and the description says `cut`. | `before/04-cut.png` |
| Follows an impaired cable (link conditions) | Yes. Both ends' notes say `impaired`, and the line has `data-conditions`. | Unchanged, and the description gives the conditions: `delay 50 ms, loss 10%`. | `before/05-impaired.png` |
| Follows VLANs (`vlan`, `trunk`) | No. Nothing on the map changed, though `topology_read` had `lan:1` in VLAN 10 and `switch0:4` a trunk. The desktop also did not render on a VLAN change until its next one-second tick. | `node4` says `lab · v10`, `lan` says `4 / 8 ports · v10`, `switch0` says `3 / 8 ports · trunk`, and the descriptions say `vlan 10` and `trunk of 1 and 10, native 1`. The desktop renders when a port's VLAN changes. | `before/06-vlans.png`, `after/06-vlans.png` |
| Follows a storm, start and end | Yes. Each storming switch's note says `storming`, and the word goes when the loop is cut. | Unchanged | `before/07-storm.png` |
| Follows blocked ports | Not built: spanning tree is stories 7.1 and 7.2. | Open. The hook is there: a line's `data-state` and the description's state word are the port's `PortView.state`, so a `blocked` state there reaches both with no change to the map. | |
| 16 machines and eight switches, every name readable | `MAX_MACHINES` is 8, so the real app cannot hold 16. A browser test builds a lab of 16 and eight switches from the model's own events and mounts the real desktop on it. No name was under another node, name or note, no line crossed a name, and every name was inside the drawing that the window scrolls. | The same, with the longer notes of this slice: VLANs, a trunk, a cable with conditions, two storms and a machine with four NICs. | `before/crowd.png`, `after/crowd*.png`; the browser test |
| A line across a name | Yes, in a lab smaller than that: a machine on two switches that are cabled together is drawn in the same column as one of them, and the line between them runs straight through the machine's name and note. | Unchanged: this is how lines are laid out. | `before/06-vlans.png` (`router`); `after/07-storm.png` |
| Usable by keyboard | Partly. Tab reaches each node in order, with a 2 px focus ring, and Enter on one opens its details. Arrow keys do nothing. The lines are an `aria-hidden` drawing, so a keyboard or screen-reader user could not learn the wiring from the map. | Each node's description says each of its cables: its NIC or port, the far end, its state, VLAN and conditions. | `results/before.txt` and `results/after.txt`, the keyboard section and the accessibility tree |
| Not by colour alone | Cut: red and dashed. Off: dotted. Impaired and storming: words. VLANs: not shown. A selected node and its lines: colour, with `aria-pressed` on the node. | VLANs in words. A cut cable is also `cut` in its ends' descriptions. Selection is as it was. | line strokes and dashes in both results |

## What was not changed, and why

- The map draws no NIC or port at a line's end. Every line from a node starts at the node's centre, so labels at the
  ends would sit on each other. Drawing them is a layout decision.
- A line between two nodes in one column crosses the upper node's name. Routing it round, or giving labels a
  background, is a layout or visual decision.
- Selection is shown by colour. Changing that is a visual decision.
