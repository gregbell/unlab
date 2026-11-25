# Phase 1 stories and the tests that show them

| Story | Box | Test |
| --- | --- | --- |
| 7.2 | strace of a simple command runs to completion and prints its system calls | test/integration/lab-image.test.ts: strace runs a command to completion and prints its system calls |
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
| 4.1 | the address is applied again after every boot (page reload, boot again, reboot, power off and on), and ls shows it | e2e/addresses.spec.ts: chosen addresses are on the NICs, in ls and in the details, and are applied again after every boot |
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
| 4.4 | a spawn option sets a machine's name | e2e/names.spec.ts: a chosen name is the guest's, and the rail, the panes, ls, the prompt and the switch show it |
| 4.4 | a name already in use, or one that is not a valid hostname, is refused | e2e/names.spec.ts: a name in use or that is not a hostname is refused in a sentence, and nothing boots |
| 4.4 | every command that takes a machine accepts that name | e2e/names.spec.ts: every command that takes a machine takes its name |
| 4.4 | the guest's hostname and prompt show it | test/integration/names.test.ts: a name on alpine, a name on debian: is the hostname and in the prompt, where node and a number is the hostname alone |
| 4.4 | the rail, the panes, ls and the prompt show it | e2e/names.spec.ts: a chosen name is the guest's, and the rail, the panes, ls, the prompt and the switch show it |
| 4.4 | capture rows show it | e2e/names.spec.ts: every command that takes a machine takes its name |
| 4.4 | capture rows show it, and a later machine of the name does not take over old rows | e2e/names.spec.ts: a name is free once its machine is gone, and the next machine of that name is another machine |
| 4.4 | a name as long as a hostname can be fits where it is shown | e2e/names.spec.ts: a name as long as a hostname can be fits everywhere it is shown |
| 4.4 | other machines resolve the name when the machine has an address | test/integration/names.test.ts: a name on alpine, a name on debian: is reached by it from a machine of either image, and reaches itself |
| 4.4 | other machines resolve the name when the machine has an address | e2e/names.spec.ts: a chosen name is the guest's, and the rail, the panes, ls, the prompt and the switch show it |
| 2.1 | a spawn option adds one or more extra disks, each with its own size | e2e/disks.spec.ts: extra disks are blank and sized as asked, take a partition and a file system, and keep them |
| 2.1 | in the guest each is a further block device of that size with nothing on it | e2e/disks.spec.ts: extra disks are blank and sized as asked, take a partition and a file system, and keep them |
| 2.1 | in the guest each is a further block device of that size with nothing on it | test/integration/disks.test.ts: extra disks on alpine, on debian are blank, of their size, and can be partitioned |
| 2.1 | in the guest each is a further block device, which the guest's boot leaves alone whatever its label | test/integration/disks.test.ts: an extra disk is left alone at boot, whatever its file system is labelled |
| 2.1 (part) | the person can partition it with tools in the image, and format and mount it after installing e2fsprogs (no stock image has a formatter for a file system the kernel mounts; the lab image is a later slice) | e2e/disks.spec.ts: extra disks are blank and sized as asked, take a partition and a file system, and keep them |
| 2.1 | ls and the machine's details list every disk and its size | e2e/disks.spec.ts: extra disks are blank and sized as asked, take a partition and a file system, and keep them |
| 2.2 (part) | what is written to any disk is there after a page reload and a boot again | e2e/disks.spec.ts: extra disks are blank and sized as asked, take a partition and a file system, and keep them |
| 2.2 (part) | what is written to any disk is there after a page reload (the root disk) | e2e/persistence.spec.ts: reload restores distinct sized machines, private files and a cut cable |
| 2.2 | rm deletes every disk the machine has, after one confirmation that lists them | e2e/disks.spec.ts: rm lists every disk it deletes, once, and what a reload cut short is deleted after it |
| 2.2 | running out of browser storage is reported in a sentence that names storage | e2e/disks.spec.ts: writing more to /dev/wdb, to /dev/wdc than the browser can store fails the machine, naming storage and the disk |
| 1.3 (part) | a machine that needs more memory than the lab has is refused, or fails, with a sentence naming memory | e2e/disks.spec.ts: a machine the browser has no memory for fails naming memory and the size, and one past the limit is refused |
| 1.3 (part) | a machine that needs more storage than the lab has fails with a sentence naming storage | e2e/disks.spec.ts: a machine the browser has no storage for fails naming storage and the disk |
| safety | an approval is for what was read: a machine that took the name, or one that gained something, is left | e2e/agent.spec.ts: a yes removes only what it was asked about: not a machine that took the name, nor one that gained a shell |
| 2.2 | what is written to any disk (root and extra) is there after a reboot | e2e/power.spec.ts: reboot brings alpine, debian back as it was, with its files and without what only its memory held |
| 2.2 | what is written to any disk (root and extra) is there after a power off and on | e2e/power.spec.ts: a machine that is off holds no memory, keeps its ports, name and disks, and stays off across a reload |
| 2.2 | what is written to any disk is there after a reboot and a power off, on real kernels of both images | test/integration/power.test.ts: alpine, debian shuts down when it is asked, ends what it runs first, and boots again on its disks |
| 5.1 | reboot takes it through booting to ready with the same name, NICs, addresses, disks, memory and cables | e2e/power.spec.ts: reboot brings alpine, debian back as it was, with its files and without what only its memory held |
| 5.1 | files on its disks are intact; processes and settings held only in memory are gone | e2e/power.spec.ts: reboot brings alpine, debian back as it was, with its files and without what only its memory held |
| 5.1 | data written just before the reboot is on disk afterwards | e2e/power.spec.ts: reboot brings alpine, debian back as it was, with its files and without what only its memory held |
| 5.1 | data written just before the reboot is on disk afterwards, when the guest reboots without syncing | e2e/power.spec.ts: what a disk had taken is kept by a guest that powers off or reboots without shutting down |
| 5.1 | data written just before the reboot is on disk afterwards, when the guest reboots without syncing | test/integration/power.test.ts: what a disk took and no one flushed is saved once the guest has powered off without syncing |
| 5.1 | the console attaches to the new boot, with its scrollback; shells opened beside it close and say why | e2e/power.spec.ts: reboot brings alpine, debian back as it was, with its files and without what only its memory held |
| 5.1 | the console attaches to the new boot after a full-screen program | e2e/power.spec.ts: a kernel that crashes is a failed machine, and a full-screen program leaves the next boot's console usable |
| 5.1 | reboot typed inside the guest does the same | e2e/power.spec.ts: reboot and poweroff typed in alpine, debian do what the commands do |
| 5.1 | reboot typed inside the guest does the same | test/integration/power.test.ts: reboot, reboot -f run by alpine's, debian's own user is a guest that goes reboot |
| 5.2 | poweroff stops it cleanly and leaves it listed as off, keeping its disks, name and ports | e2e/power.spec.ts: a machine that is off holds no memory, keeps its ports, name and disks, and stays off across a reload |
| 5.2 | poweroff stops it cleanly, and says so when it could not | e2e/power.spec.ts: a guest that does not shut down is stopped, says so, and keeps what its disks have |
| 5.2 | poweroff stops it cleanly, and says so when it could not | test/integration/power.test.ts: a guest that does not shut down is given up on, with its files written back |
| 5.2 | poweroff typed inside the guest gives the same state, not a failed machine | e2e/power.spec.ts: reboot and poweroff typed in alpine, debian do what the commands do |
| 5.2 | poweroff typed inside the guest gives the same state, not a failed machine | test/integration/power.test.ts: poweroff, halt, poweroff -f run by alpine's, debian's own user is a guest that goes off |
| 5.2 | a kernel that panics is a failed machine, not one that is off | e2e/power.spec.ts: a kernel that crashes is a failed machine, and a full-screen program leaves the next boot's console usable |
| 5.2 | a kernel that panics is a failed machine, not one that is off | test/integration/power.test.ts: a kernel that panics has not shut down |
| 5.2 | boot starts a machine that is off | e2e/power.spec.ts: a machine that is off holds no memory, keeps its ports, name and disks, and stays off across a reload |
| 5.2 | an off machine holds no memory, and stays off across a page reload | e2e/power.spec.ts: a machine that is off holds no memory, keeps its ports, name and disks, and stays off across a reload |
| 5.2 | an off machine stays off across a page reload, also one the reload caught on its way there | e2e/power.spec.ts: a reload while a machine stops ends as the stop would have, and an off machine can be removed |
| 1.4 (part) | after a spawn, reboot or power on, ls reports booting, ready, off or failed, with the reason for a failure | e2e/power.spec.ts: an agent's power calls return once the machine is where it was going, and stop waiting when told |
| 1.4 (part) | after a spawn, reboot or power on, ls reports booting, ready, off or failed, with the reason for a failure | e2e/power.spec.ts: a kernel that crashes is a failed machine, and a full-screen program leaves the next boot's console usable |
| 1.4 (part) | a command sent to a machine that is not ready says which state it is in | e2e/power.spec.ts: an agent's power calls return once the machine is where it was going, and stop waiting when told |
| 5.1, 5.2 | a NIC that ends with its guest is not reported as lost; one lost in a running guest is | e2e/power.spec.ts: a NIC that is gone from a running guest is said, and one that went down with its guest is not |
| 5.3 | one command saves a named checkpoint of all of a machine's disks | e2e/checkpoints.spec.ts: alpine, debian: a checkpoint of every disk is gone back to, over a reload, and is deleted with its machine |
| 5.3 | one command saves a named checkpoint of all of a machine's disks, at one moment while the guest writes to them | e2e/checkpoints.spec.ts: a checkpoint is of one moment on every disk, however the guest writes meanwhile, and the guest is not held up |
| 5.3 | one command saves a named checkpoint of all of a machine's disks, at one moment while they are written | src/runtime/live-copy.browser.test.ts: a checkpoint is both disks after some number of the guest's writes, whatever it writes meanwhile |
| 5.3 | another restores a checkpoint and boots the machine | e2e/checkpoints.spec.ts: alpine, debian: a checkpoint of every disk is gone back to, over a reload, and is deleted with its machine |
| 5.3 | another restores a checkpoint and boots the machine, also one that has failed | e2e/checkpoints.spec.ts: an agent's restore asks first, runs only for the checkpoint it asked about, and boots a machine that has failed |
| 5.3 | after a restore, files are exactly as they were at the checkpoint | e2e/checkpoints.spec.ts: alpine, debian: a checkpoint of every disk is gone back to, over a reload, and is deleted with its machine |
| 5.3 | checkpoints survive a page reload | e2e/checkpoints.spec.ts: alpine, debian: a checkpoint of every disk is gone back to, over a reload, and is deleted with its machine |
| 5.3 | a checkpoint or a restore that a reload cuts short | e2e/checkpoints.spec.ts: a reload while a checkpoint is saved leaves none of it, and one while a machine is restored ends restored |
| 5.3 | checkpoints are deleted with the machine | e2e/checkpoints.spec.ts: a machine can be removed while its disks are saved or restored, and nothing of it is left |
| 5.3 | the machine's details show its checkpoints and the storage they use | e2e/checkpoints.spec.ts: alpine, debian: a checkpoint of every disk is gone back to, over a reload, and is deleted with its machine |
| 2.2 (part) | running out of browser storage is reported in a sentence that names storage, while a checkpoint is saved | e2e/checkpoints.spec.ts: a checkpoint there is no room for is refused naming storage, and the machine is unharmed |
| 2.2 (part) | running out of browser storage is reported in a sentence that names storage, while a checkpoint is saved | e2e/checkpoints.spec.ts: storage that runs out under the checkpoint, under the guest while a checkpoint is saved leaves no checkpoint and an unharmed machine |
| 2.2 (part) | running out of browser storage is reported in a sentence that names storage, during a restore | e2e/checkpoints.spec.ts: a restore that runs out of storage, or whose checkpoint is gone, fails with the disks as they were |
| 1.4 (part) | ls reports what a machine is doing, and a command sent to one that is not ready says which state it is in | e2e/checkpoints.spec.ts: what stops under a checkpoint that is being saved ends it, and what would is refused |
| 7.1 | spawn accepts a lab image beside alpine and debian | e2e/lab-image.spec.ts: a lab machine with no network has the tools, and keeps a disk that it partitions and formats |
| 7.1 | with no network, a machine from it has ip from iproute2, tcpdump, curl, dig, ssh and sshd, nginx, strace, and tools to partition and format a disk | test/integration/lab-image.test.ts (all), e2e/lab-image.spec.ts: a lab machine with no network has the tools, and keeps a disk that it partitions and formats |
| 7.1 | pinned by size and checksum in the image manifest | scripts/lab-image.ts, checked by scripts/fetch-distros.ts in CI (npm run distros alpine debian lab) |
| 7.1 | boot time measured in CI beside Alpine's | e2e/lab-image.spec.ts: a lab machine boots about as fast as an Alpine one (printed, and in the job summary) |
| 2.1 | a person can partition, format and mount it with tools already in the image | e2e/lab-image.spec.ts: a lab machine with no network has the tools, and keeps a disk that it partitions and formats |
| 6.1 | one command writes given text to a given path in a guest, creating parent directories | e2e/files.spec.ts: alpine, debian: a text an agent writes arrives unchanged, with its directories, owner and mode, over a reload |
| 6.1 | one command writes given text to a given path in a guest, typed in the bar | e2e/files.spec.ts: a person writes a line from the bar, which says what it will do and did |
| 6.1 | one command writes given text to a given path, creating parent directories | test/integration/files.test.ts: alpine, debian: a new file is root's with mode 644, and a new directory is the file's owner's with 755 |
| 6.1 | a path with spaces, quotes, dollars and backslashes | test/integration/files.test.ts: alpine, debian: paths with spaces, quotes, dollars, backslashes and non-ASCII are one file |
| 6.1 | quotes, dollars, backslashes, newlines and non-ASCII arrive unchanged | e2e/files.spec.ts: alpine, debian: a text an agent writes arrives unchanged, with its directories, owner and mode, over a reload |
| 6.1 | quotes, dollars, backslashes, newlines and non-ASCII arrive unchanged | test/integration/files.test.ts: alpine, debian: a text arrives byte for byte, whatever is in it |
| 6.1 | owner and mode can be set, and system paths such as /etc can be written | e2e/files.spec.ts: alpine, debian: a text an agent writes arrives unchanged, with its directories, owner and mode, over a reload |
| 6.1 | owner and mode that are not given are kept | test/integration/files.test.ts: alpine, debian: a file that is there keeps the owner and mode that were not given |
| 6.1 | it does not type into any terminal the person is using | e2e/files.spec.ts: alpine, debian: a write leaves a person's program, half-typed line and shell history alone |
| 6.1 | the file is on the disk once the command is done | test/integration/files.test.ts: alpine, debian: what is written is on the disk at once |
| 6.1 | a write that fails, or that the machine's end cuts short, leaves the old file | e2e/files.spec.ts: a machine that goes down or comes back while it writes a file says so, and the old file is whole |
| 6.1 | a write that fails leaves the old file and says why | e2e/files.spec.ts: a file system with no room, or that is read-only, is named, and what is there stays |
| 6.1 | a write that fails leaves the old file and says why | test/integration/files.test.ts: alpine, debian: what cannot be written says why, and leaves nothing changed |
| 6.1 | a file is replaced whole | test/integration/files.test.ts: alpine, debian: a program that reads the file as it is written has the old one or the new one, whole |
| 6.1 | a file that nothing can be renamed over | test/integration/files.test.ts: alpine, debian: a file that nothing can be renamed over is written over, and put back when that fails |
| 6.1 | a write an agent withdraws, and two for one file | e2e/files.spec.ts: a write an agent withdraws is whole or not at all, and the next one comes after it |
| 6.1 | the lab's own /etc/hosts block and a write of that file | e2e/files.spec.ts: a host table that comes while an agent writes /etc/hosts is in it afterwards |
| 6.1 | approvals, the agent panel and the recent lines stay readable | e2e/files.spec.ts: a text of several lines is readable where a person approves it, and left out of the lists of lines |
| 1.4 (part) | a command sent to a machine that is not ready says which state it is in | e2e/files.spec.ts: a machine that is not ready is refused with its state |
| 0 | given only the page and the lab's tools, an agent builds a machine with two NICs and a second disk, using the addresses the page chose, and one more machine on each of its two subnets | e2e/scenario.spec.ts: an agent builds a routed network with the page's addresses, and the router's second disk outlives a reboot |
| 0 | a ping from one end machine to the other crosses the two-NIC machine | e2e/scenario.spec.ts: the same test (the ping fails once the router stops forwarding) |
| 0 | the agent reboots the two-NIC machine and finds a file it wrote to the second disk intact | e2e/scenario.spec.ts: the same test |
| 8.1 | each machine returns after a reload with its disks, NICs, name, addresses, power state, checkpoints and cables | e2e/scenario.spec.ts: a reload brings each machine back with its disks, NICs, name, addresses, power, checkpoints and cables |
| 8.2 | spawn 2 alpine and the README's first ping behave as today | e2e/first-run.spec.ts: a first visit boots two alpine, debian machines, pings the peer and restores the lab on reload; e2e/network.spec.ts; e2e/lab.ts openWithTwoMachines types `spawn 2 alpine` |
| 8.2 | existing suites pass | CI on every PR: npm run check, test:integration, test:browser, test:e2e |
