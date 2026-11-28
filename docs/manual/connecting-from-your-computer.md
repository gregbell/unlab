# Connecting from your computer

You can use a terminal on your computer to work with a machine in the browser.
Keep the lab tab open while you work.

## Two ways to connect

Choose the connection according to who needs access and what they need to do.

| What you want to do                                                                | Connection                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Use your own terminal to run commands, copy files, or reach a service on a machine | Run the command-line interface (CLI) on the computer with the browser.                                 |
| Download from public websites inside a machine                                     | Connect the CLI. The machine needs a [package gateway](networks.md#package-gateway).                   |
| Give someone on another computer SSH access to one machine                         | Share the machine through [Tailcat](#ssh-through-tailcat). The other person supplies their public key. |

You can keep the CLI connected while someone uses Tailcat.

## The CLI connection

Run the CLI on Linux or macOS with Node.js 22.12 or later, OpenSSH, and Chrome
or Chromium 150 or later.

1. In the lab menu, open **SSH access**. Under **On your computer**, you see the
   command for this lab. Run it in a terminal on your computer. For
   <https://unlab.run>, enter:

   ```sh
   npx unlab.run
   ```

   A newly started CLI prints:

   ```text
   Waiting for the lab.
   ```

   If no lab connects after a short wait, the CLI opens the lab in your browser.
   If a CLI is already running, the new prompt shares its connection.

2. If the browser asks whether the lab can reach apps on this device, allow it.
   **SSH access** shows **cli: linked** when the connection is ready. Your
   terminal lists the machines above the prompt, for example:

   ```text
   Linked to the lab: node1 (alpine), node2 (alpine)
   unlab>
   ```

   The names, images, and states depend on your lab. If the prompt was already
   open, the CLI prints the list and shows the prompt again.

3. At the CLI prompt, enter `status` to see the connection, forwarded ports, and
   open connections from your machines.

   ```text
   Linked to the lab: node1 (alpine), node2 (alpine)
   No connection to the internet is open.
   ```

   Each active internet connection has a destination and byte counts.

At the prompt, Tab completes names and the arrow keys recall commands. Ctrl+C
clears a line, declines a confirmation, or cancels the current command. To leave
the prompt, type `exit` or press Ctrl+D on an empty line. Leaving the prompt
that started the CLI disconnects it. Leaving a second prompt lets the first CLI
continue. The machines keep running in the browser.

To disconnect from the desktop, select **Turn link off** in **SSH access**. Use
**Turn link on** to connect again while the CLI is running.

## CLI options

Put CLI options before the command. To change the listening port, allowed lab
origin, or local network access, quit the running CLI and start it with the new
options.

| Option            | Effect                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `--no-open`       | If no lab connects, print the URL so you can open it yourself.                                           |
| `--origin <url>`  | Use a different lab origin. The default is <https://unlab.run>.                                          |
| `--port <n>`      | Set the local listener port. The default is 27122. Use a port from 1 through 65535.                      |
| `--wait <s>`      | Set how long a single command waits for the lab. The default is 60 seconds. Use 0 to 86400 seconds.      |
| `--log`           | Show the connections machines open.                                                                      |
| `--lan`           | Allow machines to reach this computer and its local network.                                             |
| `--version`       | Print the CLI version and exit.                                                                          |
| `--help`          | Print the invocation, commands, and options and exit.                                                    |
| `--json`, `--yes` | Request command data or answer confirmations in a [noninteractive invocation](automation-and-agents.md). |

## Internet access

When the CLI connects, a machine with a package gateway reaches public websites
and package repositories through your computer. When you disconnect the CLI, the
browser handles downloads from the configured repositories. Other websites then
become unreachable through the gateway.

The CLI carries name lookups, outbound TCP connections to IPv4 addresses, and
ping. Your computer's `ping` program sends each echo request. If it cannot run
or the destination does not reply, the machine receives no reply. The connection
does not carry UDP traffic, IPv6 traffic, or traceroute. To reach a service on
your computer or local network, start the CLI with `--lan`. To reach a service
in a machine from your computer, [forward its port](#port-forwarding).

## SSH from the CLI prompt

SSH opens a shell on a running machine, even one with no virtual network
connection. At the CLI prompt, enter `ssh node1` for a ready machine named
`node1`. A typical shell prompt is:

```text
user@node1:~$
```

The prompt shows the machine's name. Use `root@node1` as the destination for a
root shell. Exit the shell to return to the CLI prompt. To run a single shell
command instead, enter `ssh node1 -- hostname` at the CLI prompt:

```text
node1
```

On the first SSH connection, the lab starts an SSH server in the machine's
memory under `/run/unlab-ssh`. It listens on a private loopback port and accepts
the CLI's SSH key. Its traffic does not cross a virtual switch. Rebooting clears
the server. The next SSH connection starts it again.

## OpenSSH and file transfer

Use the SSH configuration that the CLI writes to reach a machine from another
terminal on the same computer. Keep the CLI running. In that terminal, run
`npx unlab.run ssh-config`.

```text
Include /home/alex/.config/unlab/ssh_config
```

This line is for a Linux account named `alex`. The directory depends on your
account and [CLI configuration](appendices.md#cli-files). Add the printed line
to the top of `~/.ssh/config`. OpenSSH can then use `<machine>.unlab` as a
destination. For example, enter `ssh node1.unlab hostname` for a ready machine
named `node1`. To use the configuration for a single invocation, give its file
name to OpenSSH with `-F`. With the default CLI directory, the same command is:

```sh
ssh -F ~/.config/unlab/ssh_config node1.unlab hostname
```

```text
node1
```

To send a file named `notes.txt` from your current directory to the machine,
run:

```sh
scp notes.txt node1.unlab:notes.txt
```

```text
notes.txt     100% …
```

In a terminal the progress line normally shows the size, speed, and elapsed
time. Reverse the two file names to copy the file back. For a directory named
`src`, use `rsync` on your computer:

```sh
rsync -av src/ node1.unlab:src/
```

```text
…
sent … bytes  received … bytes  …
…
```

The files and byte counts depend on what changed. Your computer uses its own
OpenSSH, `scp`, or `rsync`. The CLI supplies the keys, and the lab starts the
machine's SSH server with an SFTP server and `rsync` available in memory.

## Port forwarding

A forwarded port lets a program on your computer use a TCP service inside a
machine. For example, suppose a machine named `web` runs an HTTP server on port
80 and port 8080 is free on your computer. At the CLI prompt, enter
`forward web 8080:80`.

```text
localhost:8080 leads to web:80
```

Open `http://localhost:8080` on your computer to reach the server. The first
port belongs to your computer. The second belongs to the machine. Give one
number when both ports are the same. Enter `forward` alone to list the forwards.
To close this one, enter `forward --rm 8080`.

```text
localhost:8080 is not forwarded any more.
```

## SSH through Tailcat

Tailcat carries an SSH connection from another computer to a machine in your
browser. Start the machine and wait for `ready`. Ask the other person to install
Tailcat and send you one OpenSSH public key (Ed25519, RSA, or ECDSA), for
example the contents of `~/.ssh/id_ed25519.pub`. Whoever holds the matching
private key can administer this machine and its disks. See the
[Tailcat installation instructions](https://github.com/tailscale/tailcat/blob/main/INSTALL.md).

1. Open the machine's **Configuration** window. Select **Share via SSH**. The
   **Their SSH public key** field appears.
2. Paste the person's public key into the field and select **Start sharing**.
   The window shows **Share is active.** and a command beginning with
   `tailcat ssh`.
3. Select **Copy command** and give the command to the key holder. When they run
   it on their computer, they get a shell as `user` on your machine.

Select **Stop sharing** to disconnect the other person. Rebooting the machine or
reloading the tab also ends the share. Closing the configuration window alone
lets the share continue.
