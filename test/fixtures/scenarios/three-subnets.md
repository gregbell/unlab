# Three subnets, two routers

Build this network in an empty lab, with lab commands alone. Two switches carry
three subnets. Two routers join the subnets, a trunk joins the switches, and one
cable loses frames. When you are done, alice pings bob across all of it.

Run `help` to see the commands, and `help` and a verb to read one.

## Switches

Add two switches, called `core` and `edge`. Leave `switch0`, which every lab
has, empty.

Cable port 8 of `core` to port 8 of `edge`. Make that cable a trunk at both of
its ends, carrying VLANs 10 and 20. Nothing else crosses it.

## Subnets

Each subnet is a VLAN of its own.

| Subnet        | VLAN | Machines in it                     |
| ------------- | ---- | ---------------------------------- |
| `10.1.0.0/24` | 10   | alice, and r1's `eth0`             |
| `10.2.0.0/24` | 20   | r1's `eth1`, and r2's `eth0`       |
| `10.3.0.0/24` | 30   | r2's `eth1`, and bob               |

## Machines

Every machine runs Alpine and leaves out the package gateway. Put each NIC in
its subnet's VLAN, on the port that its cable is in.

| Machine | NIC    | Switch | Address        |
| ------- | ------ | ------ | -------------- |
| alice   | `eth0` | edge   | `10.1.0.10/24` |
| r1      | `eth0` | core   | `10.1.0.1/24`  |
| r1      | `eth1` | core   | `10.2.0.1/24`  |
| r2      | `eth0` | edge   | `10.2.0.2/24`  |
| r2      | `eth1` | edge   | `10.3.0.1/24`  |
| bob     | `eth0` | edge   | `10.3.0.10/24` |

## Routing

Routing is set inside the machines, once they are ready.

- r1 and r2 forward IPv4.
- alice's default route is r1, at `10.1.0.1`.
- bob's default route is r2, at `10.3.0.1`.
- r1 reaches `10.3.0.0/24` through r2, at `10.2.0.2`.
- r2 reaches `10.1.0.0/24` through r1, at `10.2.0.1`.

A machine forgets its routes and forwarding when it boots again, and a reload
of the page boots every machine. Set them again then.

## The lossy cable

The cable of r2's `eth1` loses 10% of the frames that cross it, each way.

## Done

- `topology` shows `core` and `edge`, the trunk at port 8 of each, every NIC in
  its VLAN, and `loss 10%` on the cable of r2's `eth1`.
- From alice, `ping -c 10 10.3.0.10` gets most of its replies.
- `capture icmp` shows each echo request on its way from alice: on edge
  in VLAN 10, over the trunk to r1 on core, out of r1 in VLAN 20, over the trunk
  again to r2 on edge, and out of r2 in VLAN 30, over the lossy cable, to bob.
