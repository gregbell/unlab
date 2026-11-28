# Troubleshooting

Find the symptom in the left column. The right column gives a check you can make
in the browser, at the CLI prompt, or inside the machine.

## Opening and restoring the lab

The lab uses the disks and layout saved in the current browser profile.

| What you see                                         | What to do                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The lab says it is open in another tab.              | Return to the original tab. If the CLI opened a second tab, the connection request goes to the original. Allow the browser to reach apps on your device there, then close the second tab. To move the lab to the second tab instead, close the original and reload the second. |
| You return to the lab and your machines are missing. | Open the same lab address in the same browser profile. Each profile keeps its own lab. See [Storage and checkpoints](storage-and-checkpoints.md).                                                                                                                              |
| A machine is still off after a reload.               | A machine that was off stays off. In its **Configuration** window, select **More actions**, then **Boot**.                                                                                                                                                                     |
| A file is missing, or your old terminal is gone.     | Check the file on the same machine and disk where you saved it. Files in memory disappear on reboot. A machine that boots again starts a new shell. Open another shell if you need one. See [The desktop](the-desktop.md).                                                     |

## Boot and storage failures

When a machine fails, its inventory entry includes the reason.

| What you see                                                                          | What to do                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser cannot give the machine enough memory.                                    | Close other tabs to release memory, then boot the machine again. Check the requested memory and the [resource limits](appendices.md#resource-limits) before adding more machines.                  |
| The machine reports that its disk could not be saved because browser storage is full. | Free disk space on your computer, then boot the machine again. For checkpoints or machines you can discard, see [Storage and checkpoints](storage-and-checkpoints.md) and [Machines](machines.md). |
| A checkpoint save or restore fails.                                                   | Read the reason before you retry. A failed restore leaves the machine's disks as they were. If storage is full, make space before trying again.                                                    |

## Packages and internet access

The destination matters when a machine can reach some addresses but not others.

| What you see                                                                            | What to do                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A package manager cannot download a package.                                            | In the machine's **Configuration** window, look under **Network** for **Package gateway**. It must show **Enabled**. Without the CLI, check the repository URLs listed below. Connect the CLI for HTTPS or other public mirrors. See [Package gateway](networks.md#package-gateway). |
| Packages download, but a public website is unreachable.                                 | From the lab menu, open **SSH access** and check for **cli: linked**. The CLI can reach websites over IPv4 and TCP. An IPv6-only site or a service that requires UDP needs a different route. See [Internet access](connecting-from-your-computer.md#internet-access).               |
| A public website works, but a service on your computer or local network is unreachable. | Quit the running CLI and start it again with `--lan`. Starting a second prompt in another terminal shares the running connection and keeps its network settings.                                                                                                                     |
| One machine cannot ping another machine in the lab.                                     | Check both addresses, cables, and switch ports. For machines on different switches, check the cable between switches and the VLAN settings. See [Networks](networks.md).                                                                                                             |

Without the CLI, Alpine's repository URLs must start with
`http://dl-cdn.alpinelinux.org/alpine/`. Debian can use
`http://deb.debian.org/debian/` and `http://deb.debian.org/debian-security/`.

## CLI, SSH, and port forwarding

Use the browser's connection indicator and the CLI's status to locate the
problem.

| What you see                                                              | What to do                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cli: waiting** or **cli: off**                                          | Start the CLI on the computer with the browser. Open the address it prints, including the port after `#cli=`, in the browser profile where you use the lab.                                                                                          |
| **cli: blocked**                                                          | Allow the lab to reach apps on your device in the browser's site permissions, then reload the tab.                                                                                                                                                   |
| **cli: refused**                                                          | Read the reason. If the lab is older than the CLI, reload it. If the CLI is older, quit it and start the current package with `npx unlab.run@latest`.                                                                                                |
| `Another program has port 27122. Quit it, or choose another with --port.` | Choose a free port with `--port` and open the address the CLI prints. The number in the message is the port you tried.                                                                                                                               |
| Your SSH client cannot find the machine.                                  | Check the CLI connection and the machine name and state. Use the CLI's SSH configuration for names ending in `.unlab`. See [OpenSSH and file transfer](connecting-from-your-computer.md#openssh-and-file-transfer).                                  |
| SSH through Tailcat has stopped.                                          | Check that the tab is open and the machine is ready. Start a new share after a reboot or reload. Use the command from the current share and the private key that matches its public key.                                                             |
| A forwarded port is unreachable.                                          | At the CLI prompt, enter `forward` to list the ports. Use the local port on your computer. Check that the intended service listens on the remote port in the named machine. See [Port forwarding](connecting-from-your-computer.md#port-forwarding). |

## Commands and agents

A command can wait for approval, skip a machine, or refuse to run when the lab
changes.

| What you see                                                             | What to do                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A command skips one or more machines.                                    | Read the reason for each machine. For example, a shell command needs a ready machine. Wait for the appropriate state or select a different target.                                                                                         |
| A machine's shell is busy.                                               | Let its program finish, choose another open shell by its full name, or open a new shell. See [Names and targets](commands-and-the-command-bar.md#names-and-targets).                                                                       |
| The command asks for confirmation again or reports that the lab changed. | Check the current machines, ports, and names. Read the new preview before you run or approve the command.                                                                                                                                  |
| An agent cannot see its MCP tools.                                       | Check whether MCP tools are paused or the missing MCP tool is off. For an agent using the CLI, check the CLI connection. For a browser agent, check WebMCP availability in the tab. See [Automation and agents](automation-and-agents.md). |
| The agent can see an MCP tool but the call waits.                        | Check the pending request in the agent panel. Read its arguments and approve or decline it.                                                                                                                                                |

## Switches and packet capture

Follow a frame from its switch port to the expected destination.

| What you see                                                      | What to do                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A loop or storm appears after you add a cable.                    | Inspect the inter-switch cables in the topology. Remove the redundant path or use spanning tree on the switches in the loop. Check which ports spanning tree blocks.                                                                                                |
| A frame disappears in transit.                                    | Inspect cable state, VLAN membership, and the switch counters. A cable drop can report loss, a full rate queue, or an MTU smaller than the packet. See [Networks](networks.md).                                                                                     |
| A capture is empty.                                               | Resume recording, generate traffic across the selected cable or switch, and check the filter. Traffic through the package gateway and SSH connections made through the CLI or Tailcat bypass the switches. Try a ping between two machines plugged into the switch. |
| An exported capture includes more frames than the displayed list. | Include the switch or cable in the filter to restrict the export. A protocol-only filter changes the display but exports all recorded frames. See [Packet capture](networks.md#packet-capture).                                                                     |
| One frame appears more than once in an export.                    | A frame that crosses several switches has a copy for each switch. Select a single cable in the filter to export one copy per crossing.                                                                                                                              |
