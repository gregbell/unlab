# Phase 1 stories and the tests that show them

| Story | Box | Test |
| --- | --- | --- |
| 7.2 | strace of a simple command runs to completion and prints its system calls | test/integration/strace.test.ts: strace runs a command to completion and prints its system calls |
| 1.3 (part) | a machine that needs more switch ports than the lab has is refused with a sentence naming ports | e2e/nics.spec.ts: a NIC left unplugged takes no port, and a machine that needs more ports than are free is refused |
| 3.1 | a spawn option sets how many NICs a machine has | e2e/nics.spec.ts: a two-NIC machine forwards in the browser, and the capture and its filter name each hop's NIC |
| 3.1 | each NIC is an ordinary Ethernet interface with its own MAC, usable with ip and tcpdump | test/integration/nics.test.ts: is an ordinary Ethernet interface with its own MAC, up and without an address |
| 3.1 | each NIC is an ordinary Ethernet interface with its own MAC, usable with ip and tcpdump | test/integration/nics.test.ts: shows its own traffic to tcpdump, and can be taken down and renumbered with ip |
| 3.1 | each NIC takes its own port on the switch, or is left unplugged | test/integration/nics.test.ts: that is left unplugged is there, up, and reaches nothing |
| 3.1 | each NIC takes its own port on the switch, or is left unplugged | e2e/nics.spec.ts: a NIC left unplugged takes no port, and a machine that needs more ports than are free is refused |
| 3.1 | ls and the machine's details show each NIC with its MAC, address and port | e2e/nics.spec.ts: a cable per NIC: cut one by name, from the faceplate and by machine, and a reload keeps it |
| 3.1 | with forwarding on, a packet entering one NIC leaves by the other, and the capture shows both hops | test/integration/nics.test.ts: sends a packet that enters eth0 out of eth1, and the capture has both hops |
| 3.1 | with forwarding on, a packet entering one NIC leaves by the other, and the capture shows both hops | test/integration/nics.test.ts: carries TCP whole in each direction and in both at once, in frames the wire takes |
| 3.1 | with forwarding on, a packet entering one NIC leaves by the other, and the capture shows both hops | e2e/nics.spec.ts: a two-NIC machine forwards in the browser, and the capture and its filter name each hop's NIC |
| 3.2 | link up and link down can name a single NIC of a machine | e2e/nics.spec.ts: a cable per NIC: cut one by name, from the faceplate and by machine, and a reload keeps it |
| 3.2 | naming only the machine keeps today's meaning for a machine with one NIC | e2e/command-bar.spec.ts: the bar cuts a real cable, then removes a machine after asking |
| 3.2 | naming only the machine keeps today's meaning for a machine with one NIC | e2e/nics.spec.ts: a cable per NIC: cut one by name, from the faceplate and by machine, and a reload keeps it |
| 3.2 | the capture and its filter attribute each frame to its machine and NIC | e2e/nics.spec.ts: a two-NIC machine forwards in the browser, and the capture and its filter name each hop's NIC |
| 4.1 | a spawn option sets an address and prefix for each NIC | e2e/addresses.spec.ts: chosen addresses are on the NICs, in ls and in the details, and are applied again after every boot |
| 4.1 | a spawn option sets an address and prefix for each NIC | test/integration/addresses.test.ts: of alpine, of debian holds the address it was given and no other |
| 4.1 | another option leaves a NIC up with no address | e2e/addresses.spec.ts: a machine left with no address says so, and the others' host tables have the first address of each that has one |
| 4.1 | another option leaves a NIC up with no address | test/integration/addresses.test.ts: of alpine, of debian holds the address it was given and no other |
| 4.1 | with neither, a machine gets today's 10.88.0.x address | e2e/addresses.spec.ts: chosen addresses are on the NICs, in ls and in the details, and are applied again after every boot |
| 4.1 | with neither, a machine gets today's 10.88.0.x address | e2e/nics.spec.ts: a lab saved before machines had several NICs boots on the ports it had |
| 4.1 (part) | the address is applied again after every boot, and ls shows it (page reload and boot again; reboot is a later slice) | e2e/addresses.spec.ts: chosen addresses are on the NICs, in ls and in the details, and are applied again after every boot |
| 4.2 | two machines in another subnet ping each other, and the capture shows the ARP exchange and the echoes | test/integration/addresses.test.ts: crosses the switch: the ARP exchange, then the echoes |
| 4.2 | two machines in another subnet ping each other, and the capture shows the ARP exchange and the echoes | e2e/addresses.spec.ts: the capture names the machine at each end in any subnet, and a reused address does not rename old rows |
| 4.2 | broadcast frames reach every other plugged machine | test/integration/addresses.test.ts: carries a broadcast to every other plugged machine |
| 4.2 | without the package gateway, a DHCP server on one guest gives a lease to another | test/integration/addresses.test.ts: leases an address from a DHCP server on another machine |
| 4.2 | without the package gateway, the image's own DHCP client neither delays the boot nor reaches the switch | test/integration/addresses.test.ts: boots alpine, boots debian as fast as one with it, and its boot puts nothing on the switch |
| 4.2 | with the gateway on, apk add and apt install work on a machine with a chosen address | test/integration/addresses.test.ts: installs packages on alpine, on debian, and is reached on its address |
| 4.2 | an address that collides with the gateway's own range is refused in a sentence | e2e/addresses.spec.ts: an address the machine could not use is refused in a sentence, and nothing boots |
| 4.2 | an address that collides with the gateway's own range is refused in a sentence | test/integration/addresses.test.ts: reaches the gateway only on the subnets the lab refuses |
| 4.3 | capture rows name the machine that sent and received each frame when it uses a chosen address | e2e/addresses.spec.ts: the capture names the machine at each end in any subnet, and a reused address does not rename old rows |
| 4.3 | capture <machine> matches that machine's frames on every NIC and address it has | e2e/addresses.spec.ts: the capture names the machine at each end in any subnet, and a reused address does not rename old rows |
