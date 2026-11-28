# Appendices

Use these tables to check how much the lab can hold and where the CLI keeps its
files. Use the [index](index-of-terms.md) to find a command or control.

## Resource limits

The lab checks each request against the available machines, ports, and other
resources. The browser also needs enough free memory and disk space to carry out
the request.

| Resource           | Limit                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machines           | 16 at a time. Each new machine takes the next number for its default name and MAC address, even if you choose a name. Removing a machine frees a place. Once the lab has assigned number 244, it cannot create another machine. |
| Processors         | 1 to 16 virtual CPUs per machine. If the browser cannot run multiple CPUs, the **Virtual CPUs** field accepts only 1.                                                                                                           |
| Memory             | Up to 4096 MiB per machine.                                                                                                                                                                                                     |
| Root disk          | 4, 8, 16, 32, or 64 GiB per machine.                                                                                                                                                                                            |
| Additional disks   | Up to four per machine, each 1 to 64 GiB in whole GiB. See [Storage and checkpoints](storage-and-checkpoints.md).                                                                                                               |
| Network interfaces | 1 to 4 per machine.                                                                                                                                                                                                             |
| Switches and ports | 8 switches per lab, including the default switch. Each switch has 8 ports. Each end of a cable plugged into a switch occupies one port.                                                                                         |
| Names              | Up to 63 characters for a machine, switch, or checkpoint name.                                                                                                                                                                  |
| Capture history    | The last 10,000 entries, including both frames and events. See [Packet capture](networks.md#packet-capture).                                                                                                                    |

Data limits for [automation and agents](automation-and-agents.md) apply to each
request or response:

| Data                                | Limit                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Text to write to a file             | The lab rejects text larger than 1 MiB in UTF-8.                                                              |
| Full path of that file              | The lab rejects paths longer than 4095 UTF-8 bytes.                                                           |
| Shell execution output              | The reply keeps up to the last 16,000 characters per shell and indicates when earlier output was dropped.     |
| Terminal read                       | 20 lines by default. The lab accepts requests for 1 to 500 lines.                                             |
| Decoded capture read                | 20 frames by default. The lab accepts requests for 1 to 1000 frames.                                          |
| Packet capture returned to an agent | The lab rejects files larger than 2 MiB before base64 encoding. Use the browser download for larger captures. |

## CLI files

The CLI keeps its files in `~/.config/unlab` unless you set a different
directory. It generates its own SSH keys and configuration. To use these with
your SSH client, follow
[OpenSSH and file transfer](connecting-from-your-computer.md#openssh-and-file-transfer).

| File in the CLI directory   | Purpose                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ssh_config`                | OpenSSH settings for names ending in `.unlab`. The CLI rewrites this file when it starts. Keep your own settings in `~/.ssh/config`. |
| `client.pem`, `host.pem`    | The private keys the CLI creates for client authentication and for the SSH server it starts in a machine.                            |
| `id_ed25519`, `known_hosts` | The client key in OpenSSH format and the server identity the client checks.                                                          |
| `cli.mjs`                   | A copy of the CLI that the generated SSH configuration runs to connect OpenSSH to a machine.                                         |
| `cli.sock`                  | The socket that prompts, agents, and SSH clients use to reach the running CLI.                                                       |
| `history`                   | Command lines from the CLI prompt. The prompt reads up to the last 500 lines on startup.                                             |
| `serve.log`                 | Messages from the CLI that an MCP client starts in the background. Check this file if the agent cannot connect.                      |

## CLI environment variables

The CLI reads these variables on the computer that runs it.

| Variable          | Effect                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UNLAB_CONFIG`    | Use this directory for all CLI files, including the socket. Set the same value in terminals that need the same CLI.                                          |
| `XDG_CONFIG_HOME` | If `UNLAB_CONFIG` is unset, use the `unlab` directory under this location. If both variables are unset, the CLI uses `.config/unlab` in your home directory. |
| `BROWSER`         | On Linux, run this program to open the lab URL. Without it, the CLI uses `xdg-open`. On macOS it uses `open`.                                                |

See [CLI options](connecting-from-your-computer.md#cli-options) to change the
lab origin, listener port, or network access.
