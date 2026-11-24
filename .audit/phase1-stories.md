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
