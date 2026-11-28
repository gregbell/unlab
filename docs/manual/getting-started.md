# Getting started

Start two Linux machines, save a file on one, and send a ping to the other. You
can do all of this in a browser. If you already have a lab, open
<https://unlab.run> in a new browser profile. You'll start with an empty lab and
can return to your existing machines in the original profile.

## First boot

The Welcome window offers two Alpine machines on the same switch.

1. Open <https://unlab.run>. In **Welcome to unLAB**, select **Boot 2
   machines**.

   The machines appear in **Rack manager**. When both are connected to the
   switch, the rack shows **2 links up**.

2. Select the terminal icon beside `node1` in **Rack manager**.

   The terminal for `node1` comes to the front. Wait for the shell prompt,
   `~ ⇒`, before typing.

3. Type `hostname` and press Enter. Linux prints the name of the machine where
   you ran the shell command.

   ```text
   node1
   ```

## What happens when I close the tab?

When you return in the same browser profile, the lab restores the desktop layout
and the disks of each machine. Running machines boot again with fresh shells.
Machines you powered off stay off.

1. In the terminal on `node1`, enter `hostname > ~/my-machine`. The shell writes
   the name to a file. Wait for the prompt to return.

   ```text
   ~ ⇒
   ```

   The prompt can vary with the Linux image.

2. Reload the tab. The windows return to their places. **Rack manager** shows
   **2 links up** when both machines reconnect.

3. Select the terminal icon beside `node1`. When the shell prompt appears, enter
   `cat ~/my-machine`. The new shell reads the file you saved before the reload.

   ```text
   node1
   ```

## Software installation

Your Alpine machine can download packages from its repositories through the
browser. To reach other websites,
[connect the CLI](connecting-from-your-computer.md).

In the terminal on `node1`, enter `sudo apk add curl`. A typical Alpine
installation ends like this:

```text
…
OK: … MiB in … packages
```

On a Debian machine, enter `sudo apt update && sudo apt install -y curl`
instead. A typical installation includes this line:

```text
…
Setting up curl (…)
…
```

Package versions, totals, and messages depend on what is already installed.
Enter `curl --version` to check the installation. The first line starts with the
program name and version.

```text
curl 8.…
…
```

## First ping

A ping sends a request to the other machine and waits for a reply.

1. In **Rack manager**, select `node2`. In **node2 · Configuration**, look under
   **Network** for `eth0`. In a fresh lab its address is `10.88.0.12/24`.

2. Select the terminal icon beside `node1`. In the terminal, enter
   `ping -c 1 10.88.0.12`. Use only the part of the address before the slash. A
   typical Alpine reply looks like this:

   ```text
   …
   64 bytes from 10.88.0.12: seq=0 ttl=64 time=… ms
   …
   1 packets transmitted, 1 packets received, 0% packet loss
   ```

   The time varies. One reply tells you the request reached the second machine
   and its reply reached the first.

Continue with [Connecting from your computer](connecting-from-your-computer.md)
to copy files, use SSH, or reach public websites. For more machines, see
[Machines](machines.md). To watch the ping cross a switch, see
[Packet capture](networks.md#packet-capture) in [Networks](networks.md). Try the
[Exercises](../exercises/) to investigate a change to the network.
