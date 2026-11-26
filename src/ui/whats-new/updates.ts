export interface Update {
	/** The day it reached the live lab, `2026-11-25`. */
	readonly date: string;
	/** What someone can do now. A browser remembers the newest one it has seen by this, so leave it as it is once it is out. */
	readonly title: string;
	readonly detail: string;
	/** A command bar line that shows it. */
	readonly example?: string;
	/** The pull request that has the whole story. */
	readonly pull?: number;
}

/** Newest first, and only what people notice in the lab. */
export const UPDATES: readonly Update[] = [
	{
		date: "2026-11-26",
		title: "Read the wiring in Topology",
		detail:
			"Topology says which interface of a machine each cable goes to, and the VLAN of each port. Tab to a switch or machine there to hear its cables: each port or interface, where it goes, and whether it is cut, impaired or in a VLAN.",
		example: "vlan node1 10",
	},
	{
		date: "2026-11-26",
		title: "Make a cable a bad one",
		detail:
			"Give any cable a delay, loss, reordering, a rate or an MTU with link, and watch what a poor link does to a ping or a download. The capture says which cable dropped a frame and why, and topology counts what each delivered and dropped.",
		example: "link up node1 --delay 100ms --loss 20%",
	},
	{
		date: "2026-11-26",
		title: "Put switch ports in VLANs, and trunk them",
		detail:
			"Split one switch into segments with vlan, and carry several over one cable between switches with trunk. The capture shows each frame's VLAN and its 802.1Q tag, and capture vlan 10 keeps one VLAN's frames.",
		example: "vlan node1 10",
	},
	{
		date: "2026-11-26",
		title: "Cable switches together, and make a loop",
		detail:
			"Join two switches with a cable, cut it, or take it out. Close a loop, as a cable from a switch to itself does, to watch a broadcast storm: each switch says how fast it runs, and the lab still answers.",
		example: "cable switch0 switch0",
	},
	{
		date: "2026-11-26",
		title: "Your lab has a desktop",
		detail:
			"Boot your first guests from Welcome. Open a machine or switch in Rack manager, follow its cables in Topology, and arrange terminals and captures in their own windows.",
	},
	{
		date: "2026-11-25",
		title: "Follow a packet from switch to switch",
		detail:
			"Filter the capture by a switch, or by one cable, and save that cable as a .pcap. With several switches, each row says where the frame came in and went out.",
		example: "capture switch0:1",
	},
	{
		date: "2026-11-25",
		title: "SSH into a machine, and the internet in it",
		detail:
			"Run npx unlab.run in a terminal. It opens shells in your machines, copies files, runs lab commands, and gives machines the internet through your computer.",
	},
	{
		date: "2026-11-25",
		title: "Move a cable while a machine runs",
		detail:
			"Plug a network interface into another switch, at a port you name or the lowest free one, or unplug it. Build a router between two switches.",
		example: "plug node1 switch0:5",
	},
	{
		date: "2026-11-25",
		title: "More than one switch",
		detail:
			"Add up to eight, and choose which one each network interface is plugged into. topology lists what is in every port.",
		example: "mkswitch lan",
	},
	{
		date: "2026-11-25",
		title: "Park and maximise each panel",
		detail:
			"The capture and switch0 have the same two buttons as consoles. A parked panel waits by name in the bar at the bottom.",
		pull: 19,
	},
	{
		date: "2026-11-25",
		title: "Help for every command",
		detail: "Help gives a command’s options and an example. A command that cannot run says what would work instead.",
		example: "help spawn",
		pull: 18,
	},
	{
		date: "2026-11-25",
		title: "unlab has its own address",
		detail: "The live lab is at unlab.run.",
		pull: 17,
	},
	{
		date: "2026-11-25",
		title: "Write a file on a machine",
		detail: "Put a text in a file as root, with the directories it needs.",
		example: "write node1 /etc/motd --mode 644 -- hello",
		pull: 16,
	},
	{
		date: "2026-11-25",
		title: "A lab image with the tools in it",
		detail: "Alpine with iproute2, tcpdump, curl, dig, ssh, nginx and disk tools already installed.",
		example: "spawn 1 lab",
		pull: 15,
	},
	{
		date: "2026-11-25",
		title: "Checkpoints",
		detail: "Save a machine’s disks under a name, break something, and put them back.",
		example: "checkpoint node1 before",
		pull: 14,
	},
	{
		date: "2026-11-25",
		title: "Install unlab as an app",
		detail: "Choose Install in Chrome’s address bar to open the same lab in its own window.",
		pull: 13,
	},
	{
		date: "2026-11-25",
		title: "Reboot machines and turn them off",
		detail: "A machine that is off keeps its disks, name and ports. Typing reboot in the guest works too.",
		example: "reboot node1",
		pull: 12,
	},
	{
		date: "2026-11-25",
		title: "Extra disks",
		detail: "Give a machine up to four blank disks to partition and format.",
		example: "spawn 1 alpine --extra-disk 1,4",
		pull: 11,
	},
	{
		date: "2026-11-25",
		title: "Name your machines",
		detail: "The name is the machine’s hostname, and what every command and every other machine calls it.",
		example: "spawn 1 alpine --name web",
		pull: 10,
	},
	{
		date: "2026-11-24",
		title: "Choose addresses",
		detail: "Lay out your own subnets. Leave out the package gateway to run your own DHCP.",
		example: "spawn 1 alpine --addr 10.1.0.1/24 --no-gateway",
		pull: 9,
	},
	{
		date: "2026-11-24",
		title: "Up to four network interfaces",
		detail: "Build a router. Each interface has its own cable to plug in or cut.",
		example: "spawn 1 alpine --nics 2 --net switch0,none",
		pull: 8,
	},
	{
		date: "2026-11-24",
		title: "Agents can drive the lab",
		detail: "WebMCP works in Chrome, and the agent panel walks you through connecting one.",
		pull: 1,
	},
];
