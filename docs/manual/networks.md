# Networks

Plug machines into a switch to send traffic between them. Add switches to build
a larger network, change how a cable carries traffic, or watch a ping cross the
network one switch at a time.

In this chapter, `router:eth1` means the interface `eth1` on the machine
`router`. An interface is the point where a machine attaches to a network.
`lan:3` means port 3 on the switch `lan`. Select a device in **Rack manager** to
see its connections, or open **Topology** from the lab menu to see the whole
network.

## Interfaces and addressing

When you [create a machine](machines.md#machine-creation), you choose its
interfaces, the switch each one plugs into, and the addresses Linux uses on
them. A machine has one to four interfaces, named `eth0` through `eth3`. In
commands that take one interface, the machine name alone suffices if it has only
one.

1. In the machine wizard, select **Network**. The first interface is `eth0`.
   Select **+ Interface** if the machine needs a second one. A row for `eth1`
   appears with its own switch and address fields.
2. Choose a switch for each interface, or choose **Unplugged** to leave its
   cable out. Each switch choice shows how many ports are free.
3. To supply the addresses for a single machine, select **Set interface
   addresses manually**. Enter an address and prefix such as `10.1.0.1/24` in
   the field for each interface you want to configure. A blank field leaves that
   interface without a lab address. When creating a batch, you can select
   **Leave all interfaces without addresses**.

After boot, select the machine in **Rack manager**. Under **Network** you can
read the assigned address and switch port beside each interface.

By default the first machine gets `10.88.0.11/24` on `eth0`, the second gets
`10.88.0.12/24`, and so on. Other interfaces start without a lab address. The
number after the slash is the prefix length, the number of bits that identify
the network. Supply a prefix from 1 to 32 with a custom IPv4 address. Linux
receives the configured addresses again at each boot.

To make these choices in the command bar, use the following options with
[the machine creation command](machines.md#spawn-create-machines).

| Option at creation        | Effect                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--nics 2`                | Give the machine two interfaces. The default is one.                                                                                                        |
| `--net lan`               | Plug each interface into the lowest free port of the existing switch `lan`. The default switch is `switch0`.                                                |
| `--net lan,none`          | Plug the first interface into `lan` and leave the second unplugged. Give one entry per interface when they differ.                                          |
| `--no-net`                | Start with every interface unplugged and no package gateway.                                                                                                |
| `--addr 10.1.0.1/24,none` | Set the first interface's lab address and leave the second without one. Give one entry per interface. Create one machine at a time when choosing addresses. |

The two machines in [First ping](getting-started.md#first-ping) can reach each
other on `switch0`. In
[Connect two switches](../exercises/connect-two-switches.md), move `node2` onto
another switch, join the switches with a cable, and follow the request and reply
across the new ports.

## Package gateway

The package gateway gives `eth0` a separate route to the package repositories.
It supplies the address `10.0.2.15` and a default route. Linux uses that route
for destinations without a more specific route. Cutting the cable to the switch
stops traffic to other machines on that cable. Package access still works after
a cut or a move to another switch. Gateway traffic bypasses the switch, so it
does not appear in the switch capture.

In the wizard's **Network** step, clear **Package gateway on eth0** if you want
to supply your own routes or DHCP service. In the command bar, use
`--no-gateway` at creation. DHCP lets a machine request its network settings.
With the gateway enabled, keep your networks outside the two ranges it uses. The
gateway leases addresses from `10.0.2.0/24` and answers DNS queries for
repository names with addresses in `198.51.100.0/24`. Starting with `eth0`
unplugged also leaves out the gateway. Plugging the interface in later gives it
a switch port but does not add a gateway. With a
[CLI connection](connecting-from-your-computer.md), the same gateway can reach
public websites through your computer.

## Switches and cables

Each switch has eight ports. A machine interface takes one port, and a cable
between switches takes a port at each end. The lab starts with `switch0` and can
hold eight switches in total.

1. In **Rack manager**, open **Add** and choose **Add switch…**. The **Switch
   name** field appears.
2. Enter an unused name, or leave the field blank for an automatic name.
3. Select **Add switch**. The new switch appears in the rack with eight free
   ports.

## Patching a machine interface

Use **Patch** to plug a machine into a switch, move it to another port, or
unplug it.

1. Select a ready or powered-off machine in **Rack manager**. In
   **Configuration**, find the interface under **Network**. Its row shows the
   current switch and port, or **Unplugged**.
2. Select **Patch** beside that interface. In the **Patch cable** window,
   **Machine interface** shows the selected interface. **Destination** lists the
   free ports.
3. Choose the destination port and select **Connect**. The interface row shows
   its new port. To free its port instead, choose **Unplug** as the destination
   and select **Unplug**. The row now reads **Unplugged**.

You can also start at the switch. In **Switch details**, select **Patch** on a
free port. The destination is already selected.

## Cutting and removing cables

Cut a cable to interrupt traffic and keep both ends in place. In **Switch
details**, choose **Cut cable** in the occupied port's row. The state changes to
`cut`. Choose **Reconnect** to restore the cable. For a cable to a machine,
these controls are available when the machine is ready or off.

A cut cable keeps its port, [VLAN and path cost](#vlans-and-spanning-tree), and
[cable conditions](#cable-conditions). Moving a machine's cable keeps its
conditions and its cut state. Removing the cable discards its conditions. When
the port becomes free, its VLAN and path cost return to their defaults. Wiring
and configuration survive a browser reload. **Switch details** shows
**Available** beside each free port.

To join two switch ports, use the [`cable` command](#cable-join-switch-ports) in
the command bar. The cable appears in **Topology**. In **Switch details**, the
port names the switch and port at the other end. Select **Remove** in either
port row to free both ends.

## Switch removal

You can remove any switch you added to the lab.

> [!WARNING]
>
> Removing a switch discards its port settings, learned addresses, and counters.
> It removes the cables to other switches and unplugs its machines. The machines
> keep running.

1. Select the switch in **Rack manager**. **Switch details** shows its ports.
2. Open **More actions** and choose **Delete switch…**. The command bar asks you
   to confirm the removal.
3. Check the switch name and confirm. The switch disappears from the rack.

## Wiring commands

Enter these commands in the command bar or at the CLI prompt to change the
switches and cables by name.

### `mkswitch`: Add a switch

```text
mkswitch [name]
```

Add an empty switch. Omit the name for the first available name in the series
`switch1`, `switch2`, and so on. A chosen name starts with a lowercase letter
and can contain lowercase letters, digits, and interior hyphens. Names can have
up to 63 characters. Choose a name that no machine or switch already uses.
Reserved names are refused.

MCP tool: `switch_add`

With room for a switch and the name `lan` available, enter `mkswitch lan`.

```text
added lan
```

### `plug`: Attach or move an interface

```text
plug <nic> <switch[:port]>
```

Plug one interface of a ready or powered-off machine into a switch. Give a port
number to choose a free port. A switch name alone keeps the current port on that
switch or takes the lowest free one. A running machine keeps running.

MCP tool: `cable_plug`

For a ready, single-interface `node1` with an uncut cable on another switch and
port 3 free on `lan`, enter `plug node1 lan:3`.

```text
node1 plugged into lan port 3 · up
```

### `unplug`: Free a machine's port

```text
unplug <nic>
```

Remove one interface's cable from its switch. The machine keeps its address. Its
interface stays unplugged after reboot or reload.

MCP tool: `cable_unplug`

For a ready, plugged-in `node1` with one interface, enter `unplug node1`.

```text
node1 unplugged
```

### `cable`: Join switch ports

```text
cable <switch[:port]> <switch[:port]>
```

Join two free ports with a cable. A switch name alone selects its lowest free
port. You can join the same two switches more than once, or join two different
ports of one switch. The command reports when a new cable closes a loop. See
[loops and storms](#loops-and-storms) before adding the second path.

MCP tool: `switch_cable`

If `switch0` and `lan` have no path between them and both have port 8 free,
enter `cable switch0:8 lan:8`.

```text
cabled switch0:8 to lan:8
```

### `uncable`: Remove a cable between switches

```text
uncable <switch:port>
```

Name either end of a cable between switches to free both ports. Both switches
forget the addresses they learned over that cable.

MCP tool: `switch_uncable`

For a cable from `lan:8` to `switch0:8`, enter `uncable lan:8`.

```text
removed the cable from lan:8 to switch0:8
```

### `rmswitch`: Remove a switch

```text
rmswitch <switch>
```

Remove a switch that you added. The lab keeps its original switch, `switch0`.

MCP tool: `switch_remove`

> [!WARNING]
>
> Removing a switch discards its port settings, learned addresses, and counters.
> It removes the cables to other switches and unplugs its machines. The machines
> keep running.

To remove an empty switch named `lan`, enter `rmswitch lan`. At the command bar,
select **Remove lan** to confirm.

```text
removed lan
```

For an occupied switch the result also names the disconnected interfaces and
removed cables.

## Cable conditions

A cable can delay frames, lose some of them, or limit their size or speed. A
frame is the unit of data a switch receives on a port. Conditions act in both
directions on the selected cable. They survive cutting, moving the cable, or
rebooting its machine. Other cables keep their own settings.

To check a cable, open its switch in **Rack manager**. When a cable has a
condition, **Switch details** shows a **Conditions** column with the settings
and traffic counts. Set or clear conditions with the command below.

### `link`: Cut, reconnect, or change cables

```text
link <up | down> <machines> [--delay time] [--loss percent] [--reorder percent] [--rate rate] [--mtu bytes] [--clear]
```

Use `down` to cut a cable in place and `up` to reconnect it. To change
conditions on a working cable, give the options with `up`. Use `down` to set
conditions while cutting the cable or while it remains cut. On an unplugged
interface, `up` plugs it into the lowest free port on `switch0`. Use
[`plug`](#plug-attach-or-move-an-interface) to choose another switch.

Name one interface, a machine for all its interfaces, or a port for the cable in
it. Either end identifies a cable between switches. A comma list combines
targets. A name pattern or `all` selects matching machines. Machines must be
ready or powered off. A cable to a powered-off machine can carry traffic when
the machine boots.

| Option      | Effect                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--delay`   | Delay each frame by 1 ms to 10 s, in whole milliseconds. Write `100ms` or `1.5s`. Zero removes the delay.                                                                                               |
| `--loss`    | Drop a share of the frames, from 0 to 100%. Fractions such as `0.5%` are valid.                                                                                                                         |
| `--reorder` | Let a share of frames skip the delay. Use 0 to 100%. A nonzero value requires a delay.                                                                                                                  |
| `--rate`    | Limit each direction to between `1kbit` and `10gbit` per second. The queue holds 64 KiB. Zero removes the rate limit.                                                                                   |
| `--mtu`     | Set the maximum transmission unit (MTU), the largest packet the cable carries. Choose 68 to 1500 bytes, excluding the Ethernet header. The cable drops larger packets. Use 1500 to restore the default. |
| `--clear`   | Remove all conditions before applying any other options on the line. Otherwise omitted options keep their values.                                                                                       |

MCP tool: `link_set`

For a ready, single-interface `node1` with an uncut cable and no conditions,
enter `link up node1 --delay 100ms --loss 20%`.

```text
node1 up with delay 100 ms and loss 20%
```

## Topology and counters

Open **Topology** to see where a cable goes. Hover over a machine or switch to
read its connections. A cut cable appears as a red dashed line. A dotted line
marks a machine that is off, booting, restoring, or stopping. A dash-dotted line
marks a port blocked by the spanning tree.

In **Rack manager**, select a switch to inspect each numbered port. Under
**Ports**, select the machine or far end of a cable to open its details. See
[Patching a machine interface](#patching-a-machine-interface) to move a cable,
or [Cutting and removing cables](#cutting-and-removing-cables) to interrupt
traffic.

In **Switch details**, scroll below **Ports** to **Counters** for the switch's
frame totals and its count of active addresses. Under **MAC address table**,
find an Ethernet address to see which port learned it. **Machine** identifies
the interface when the address belongs to a lab machine. **Seen** shows how long
ago the switch last received a frame from that address, or `flushed, link down`
when the switch has stopped using the entry. Use
[`macs`](#macs-list-learned-addresses) to read the tables for several switches
together.

### `topology`: List the wiring

```text
topology
```

List each switch, its ports, and the unplugged interfaces. Each occupied port
names the far end and gives the state of the cable. An uncut cable to a machine
that is not ready reads `down`. A cut cable reads `cut`. A cable between
switches appears under both switches.

Check the port for cable conditions and counters. Delivered frames crossed the
cable. Dropped frames include those lost to a configured loss rate, those too
large for the MTU, and those that exceeded the rate queue. Cable counts start
when the cable is put in. For totals per switch, see
[the MAC table](#macs-list-learned-addresses).

MCP tool: `topology_read`

In a lab with one empty switch, `switch0`, enter `topology`. The report starts
with this line.

```text
1 switch · 0 of 8 ports taken
…
```

The counts change as you add switches and cables.

## Loops and storms

A loop gives frames a path back to a switch they have already crossed. A
broadcast frame can keep going around the loop, creating a storm. A switch
receiving looped frames shows `storming` in **Rack manager**. Select that switch
and read **Storm** for the rate of returning frames and the number dropped. The
[wiring report](#topology-list-the-wiring) gives the same figures. The capture
records when the storm starts and ends.

The lab limits looped traffic in each direction of a cable to 1,000 frames a
second, with room for 64 waiting frames. To end a storm, cut enough cables to
break every active loop, or enable
[spanning tree](#stp-enable-or-disable-spanning-tree) on the switches in the
loop.

## VLANs and spanning tree

A virtual LAN (VLAN) groups ports that can exchange traffic on a switch.
Broadcasts stay in their VLAN. To send traffic for several VLANs across a single
cable between switches, configure both ends as trunks.

Open the switch in **Rack manager** to inspect these settings. When a port has a
VLAN configuration beyond the default, **Switch details** shows the **VLAN**
column. With spanning tree enabled, a participating port shows its role in
**Spanning tree**. A forwarding port shows the role alone. A port still learning
addresses also shows `learning`, and a port kept out of use shows `blocked`. Use
the commands below to change VLAN membership, trunks, and spanning-tree
settings.

### `vlan`: Set a port's VLAN

```text
vlan <port> <vlan>
```

Make an occupied port an access port in one VLAN, numbered 1 to 4094. Name the
port or the machine interface plugged into it. The switch sends untagged frames
out of an access port and assigns its incoming untagged frames to that VLAN.
Applying this command to a trunk makes it an access port again. Ports start in
VLAN 1.

MCP tool: `port_vlan`

For an occupied `switch0:1` in VLAN 1, enter `vlan switch0:1 10`.

```text
switch0:1 vlan 10
```

### `trunk`: Carry several VLANs on a port

```text
trunk <port> [--allow vlan,...] [--native vlan]
```

Make one end of a cable between switches a trunk. A trunk puts a VLAN number in
an Ethernet tag on each outgoing frame, except for frames in its native VLAN.
Untagged incoming frames belong to the receiving port's native VLAN. Use the
same native VLAN at both ends to keep untagged traffic in the same VLAN. The
Linux kernel in the lab images lacks 802.1Q VLAN tag support. For a machine that
needs several VLANs, give it one interface and access port per VLAN.

| Option     | Meaning                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `--allow`  | A comma-separated list such as `10,20`, or `all` (the default). Other VLANs cannot cross.                            |
| `--native` | VLAN for untagged traffic, 1 by default. If the allowed list excludes it, the trunk carries no untagged data frames. |

MCP tool: `port_trunk`

For an access port `lan:1` cabled to another switch, enter
`trunk lan:1 --allow 10,20 --native 10`.

```text
lan:1 trunk of 10 and 20, native 10
```

Configure the other end of the cable to carry the same VLANs.

### `stp`: Enable or disable spanning tree

```text
stp <on | off> <switches>
```

Enable rapid spanning tree to keep spare paths between switches. Participating
switches exchange control frames called BPDUs. They choose a root switch and
block the ports that would close a loop. One tree covers all VLANs. If a cable
in use is cut, a blocked port can take over. Inspect the role and state of each
port in [the wiring report](#topology-list-the-wiring).

Spanning tree starts off on each new switch. A switch with it off does not
forward BPDUs, so a loop through it can still storm. Name one switch, a
comma-separated list, or `all`.

MCP tool: `switch_stp`

If `switch0` is the only switch and spanning tree is off, enter `stp on all`.

```text
spanning tree on for switch0
```

### `priority`: Choose a preferred root

```text
priority <switches> <priority>
```

Set the priority of one switch, a comma-separated list, or all switches. The
lowest priority wins the root election. The lower bridge address breaks a tie.
The default priority is 32768. Choose a multiple of 4096 from 0 to 61440. The
switch keeps its priority while spanning tree is off.

MCP tool: `switch_priority`

If `lan` participates in the tree and the other switches use the default
priority, enter `priority lan 4096` to prefer `lan` as root.

```text
priority 4096 for lan
```

### `cost`: Set the cost of a port

```text
cost <port> <cost>
```

Set the cost of an occupied port by its name or the interface plugged into it.
Each switch uses the path to the root with the lowest total cost, adding the
costs of the ports the path enters. Increasing a port's cost can make another
path preferable. Set a whole number from 1 to 200000000. A port starts at 20000
and returns to that cost when it becomes free.

MCP tool: `port_cost`

For an occupied `lan:3` with the default cost and spanning tree on, enter
`cost lan:3 200000`.

```text
lan:3 costs 200000
```

### `macs`: List learned addresses

```text
macs [switches]
```

Read a switch's MAC table to find the port where it last received a frame from
an Ethernet address. The switch learns addresses separately for each VLAN. Each
row gives the port and the time since the address last sent a frame. An active
entry expires after five minutes without a frame from that address. Cutting a
cable marks the entries for that port `flushed, link down`. These entries no
longer direct traffic. The label can remain after you reconnect the cable. The
switch starts using an address again when it receives a new frame from it. After
moving a machine, send traffic from it so the switches learn its new location.

Omit the argument to list all switches. The report also gives the number of
frames each switch received, the copies it delivered to ports, and the frames it
flooded. A switch floods a frame when it sends copies to other ports in the
VLAN, for example for a broadcast.

MCP tool: `switch_macs`

On a new `lan` with no traffic, enter `macs lan`. The report starts with the
number of active entries.

```text
lan · 0 learned
…
```

## Packet capture

Select **Open capture** beside a switch in **Rack manager** to see the frames
crossing that switch. To inspect all switches together, open **Packet capture**
in the lab menu and choose **Packet inspector**. Capture runs while the lab is
open, including when the inspector is closed.

Select a frame in the inspector to read its headers and bytes. The port numbers
show where the frame entered the switch and where it went next. A frame can have
several outgoing ports. The detail shows its VLAN and which ports carried a tag
when applicable. A cable drop identifies the port and reason. Separate rows
record cable changes and storms.

Select **pause** to stop adding rows while you read. The switches keep
forwarding frames and counting them. Select **resume** to record new rows.
**clear** empties the capture and keeps the counters. The buffer holds the
newest 10,000 rows, including events. A reload starts a new capture.

To download the frames for a switch or cable, include its name in the filter in
**Packet inspector** and select **save .pcap**. See
[what the file contains](#pcap-save-captured-frames) if your filter also names a
machine or protocol.

## Capture filters

Type a filter in the inspector to narrow the view of the captured traffic. A
space between terms requires both to match. Use `or` between alternatives. For
example, `switch0 icmp or switch0 arp` shows ICMP and ARP on `switch0`. An empty
filter shows all frames. Protocol filters also keep cable and storm events for
context.

| Term                                | Frames it selects                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `switch0`, `lan:3`                  | Frames captured on a named switch, or at one cable on that switch.                                   |
| `port:3`                            | Traffic on port 3 of any switch.                                                                     |
| `node2`, `router:eth1`              | A machine or a specific interface, wherever its frames went.                                         |
| An IPv4 or MAC address              | Frames with that address at either end, including IPv4 addresses in ARP requests and replies.        |
| `vlan 10`                           | Frames the switch carried in VLAN 10, including frames that had no tag on the cable.                 |
| `arp`, `ip`, `ipv4`, `ipv6`, `stp`  | ARP, IPv4 (`ip` or `ipv4`), IPv6, or spanning-tree frames.                                           |
| `icmp`, `tcp`, `udp`, `dhcp`, `dns` | IPv4 traffic. Use `icmp` for a ping, `dhcp` for UDP port 67 or 68, and `dns` for TCP or UDP port 53. |

An agent can use the MCP tool `capture_read` to read decoded frames with the
same filter. It returns the newest matching frames, oldest first, and omits
event rows. The default limit is 20 frames. Request up to 1,000. See
[Automation and agents](automation-and-agents.md).

### `capture`: Show matching frames

```text
capture <filter>
```

Open the inspector with the given filter. Leave the filter empty to see every
frame. Editing the filter changes what you see in the existing buffer.

For traffic on the default switch, enter `capture switch0 icmp`.

```text
showing frames matching switch0 icmp
```

### `pcap`: Save captured frames

```text
pcap <filter>
```

Save the current buffer as an Ethernet capture file for a packet analyzer. In
the inspector, **save .pcap** uses the displayed filter. The command uses the
filter you enter with it.

| Filter                                               | What the file contains                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Names a switch or a cable, alone or with other terms | Only matching frames. Name one cable to get each frame once with the VLAN tag it had on that cable.                                         |
| Empty, or names no switch or cable                   | Every frame in the buffer, once for each switch that carried it. A protocol, machine, VLAN, or `port:3` filter alone affects only the view. |

At the command bar or CLI prompt, the browser downloads the file. The MCP tool
returns the file name, frame count, size, and base64-encoded bytes. It accepts
files up to 2 MiB. For a larger file, narrow the filter to a switch or cable, or
save the download through the browser.

MCP tool: `capture_save`

With two captured frames at `switch0:1`, enter `pcap switch0:1`.

```text
saved unlab-switch0-port1.pcap to downloads · 2 frames
```

The file name follows the filter. The count depends on the buffered traffic.
