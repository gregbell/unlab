# Getting started

Start two Linux machines and test the cable between them. Then save a file and
install software on one machine. You can do all of this in a browser. If you
already have a lab, open <https://unlab.run> in a new browser profile. You'll
start with an empty lab and can return to your existing machines in the original
profile.

## First boot

The Welcome window offers two Alpine machines on the same switch.

Open <https://unlab.run>. In **Welcome to unLAB**, select **Boot 2 machines**.

The machines appear in **Rack manager**. When both are connected to the switch,
the rack shows **2 links up**.

## First ping

A ping sends a request to the other machine and waits for a reply.

1. In **Rack manager**, select `node2`. Under **Network**, find the address of
   `eth0`. In this fresh lab it is `10.88.0.12/24`.
2. Select `node1` in the rack. Its **Configuration** window shows **Ping node2**
   under **Network** when both machines are ready.

3. Select **Ping node2**. The terminal on `node1` comes forward. It sends three
   requests to `node2`. A typical Alpine result looks like this:

   ```text
   …
   64 bytes from 10.88.0.12: seq=0 ttl=64 time=… ms
   …
   3 packets transmitted, 3 packets received, 0% packet loss
   ```

   The time varies. Each reply tells you a request reached the second machine
   and its reply reached the first.

## Cutting and reconnecting a cable

Cut the cable to `node2` to see what happens to the ping.

1. In **Rack manager**, select `switch0`. Under **Ports**, find the row for
   `node2`. Its cable reads `up`.
2. Select **Cut cable** in that row. The port still names `node2`, and its state
   changes to `cut`.
3. Open the terminal for `node1` from the rack. Enter
   `ping -c 1 -W 2 10.88.0.12` to send one request to the same address and wait
   up to two seconds. With the cable cut, the summary reads:

   ```text
   1 packets transmitted, 0 packets received, 100% packet loss
   ```

4. Select `switch0` in the rack again. Choose **Reconnect** in the same port
   row. It reads `up`. Repeat the shell command on `node1`. The reply returns:

   ```text
   1 packets transmitted, 1 packets received, 0% packet loss
   ```

## What happens when I close the tab?

When you return in the same browser profile, the lab restores the desktop layout
and the disks of each machine. Running machines boot again with fresh shells.
Machines you powered off stay off.

1. In the terminal on `node1`, enter `hostname`. Linux prints the name of the
   machine where you ran the shell command.

   ```text
   node1
   ```

2. Enter `hostname > ~/my-machine`. The shell writes the name to a file. Wait
   for the prompt to return.

   ```text
   ~ ⇒
   ```

   The prompt can vary with the Linux image.

3. Reload the tab. The windows return to their places. **Rack manager** shows
   **2 links up** when both machines reconnect.

4. Select the terminal icon beside `node1`. When the shell prompt appears, enter
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

To follow the ping across another switch, try
[Connect two switches](../exercises/connect-two-switches.md). To add a machine,
see [Machines](machines.md#machine-creation). To copy files, use SSH, or reach
public websites, see
[Connecting from your computer](connecting-from-your-computer.md).
