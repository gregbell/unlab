# Machines

Choose what each machine runs and how much memory, disk space, and network
equipment it needs. You can change its power state later and keep its files for
the next boot. Enter the commands in the command bar at the top of the desktop
or at the CLI prompt on [your computer](connecting-from-your-computer.md).

## Images and names

The image supplies the Linux system a new machine boots.

| Image    | When to use it                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpine` | Use Alpine and install packages with `apk`.                                                                                                                                                                   |
| `debian` | Use Debian and install packages with `apt`.                                                                                                                                                                   |
| `lab`    | Use Alpine with network and disk utilities such as `tcpdump`, `curl`, `dig`, `lsblk`, and `mkfs.ext4` already installed. Choose this image if you need these tools on a machine without a network connection. |

Each machine has its own disks. Its name in the lab is also its Linux hostname.
Automatic names start at `node1` and advance for each new machine. Removing a
machine does not reset the counter. To give a machine a name such as `web`,
create it on its own. Start the name with a lowercase letter, use lowercase
letters, digits, and hyphens, and end with a letter or digit. The limit is 63
characters. Names must be available. The lab reserves automatic names and words
such as `all` and `localhost`.

## Machine creation

Use **Add machines…** from **Rack manager** or the lab menu to choose the image,
compute resources, disks, and network interfaces before booting. **Review**
shows the choices for the batch. For a custom hostname, set **Machines** to one.
A larger batch gets one automatic name per machine.

### `spawn`: Create machines

```text
spawn <count> <image> [--mem MiB] [--cpus CPUs] [--disk 4 | 8 | 16 | 32 | 64] [--extra-disk GiB,...] [--name name] [--nics NICs] [--net network,... | --no-net] [--addr address,...] [--no-gateway]
```

Create one or more machines with the same settings and start them. The lab holds
16 machines. Each plugged interface needs a free switch port. If your batch
exceeds either limit, reduce the count or change its network attachment.

| Option         | Meaning                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mem`        | Memory per machine in MiB. Default 256, maximum 4096.                                                                                                                                                 |
| `--cpus`       | Virtual CPUs per machine, from 1 to 16. The default is 2. Browsers without shared CPU worker support use 1 and accept only 1.                                                                         |
| `--disk`       | Capacity of the writable disk in GiB. The default is 4.                                                                                                                                               |
| `--extra-disk` | Comma-separated capacities in GiB for up to four [additional disks](storage-and-checkpoints.md#additional-disks) per machine.                                                                         |
| `--name`       | Hostname for a single machine.                                                                                                                                                                        |
| `--nics`       | Number of network interfaces, 1 to 4. The default is 1.                                                                                                                                               |
| `--net`        | Switch name or `none`. One value applies to every interface. To choose separately, give one comma-separated value per interface. The default is `switch0`.                                            |
| `--no-net`     | Leave all interfaces unplugged.                                                                                                                                                                       |
| `--addr`       | Supply an address and prefix, or `none`, for each interface in order. Set the count to 1 when you supply an explicit address. By default only `eth0` gets a lab address. See [Networks](networks.md). |
| `--no-gateway` | Start without a route to the package repositories. The machine also starts without a gateway if you leave its first interface unplugged.                                                              |

MCP tool: `machines_spawn`

In a fresh lab, enter `spawn 2 alpine`.

```text
booting node1 and node2
```

Names depend on the machines created so far. The result means boot has started.
Check [`ls`](#ls-list-machines) for each machine's state or reason for failure.

## Software installation

Use the package manager in the machine's terminal to install software on its
writable disk. The configured Alpine and Debian repositories work through the
package gateway in the browser. See
[Software installation](getting-started.md#software-installation) for commands
and sample output. To download from a public website, see
[Connecting from your computer](connecting-from-your-computer.md).

## Machine inventory

Select a machine in **Rack manager** to see its configuration. **Compute** shows
its image, virtual CPUs, and memory. **Storage** lists devices and capacities.
**Network** shows the assigned addresses, ports, and package gateway setting.

### `ls`: List machines

```text
ls
```

List the machines, their state, and the total memory currently assigned. Each
machine's details include its configured addresses, cables, disks, checkpoints,
and shell sessions. A failed machine shows its failure reason.

MCP tool: `machines_list`

In a lab with one ready machine using 256 MiB, enter `ls`. The report starts
with:

```text
1 machine · 1 ready · 256 MiB of memory
…
```

The counts and total memory depend on the lab. Booting, ready, and stopping
machines count toward that memory total.

## Power states

A ready machine accepts shell commands. A machine that is off keeps its disks
and cables. In the command bar, a power command reports when the change starts.
Enter [`ls`](#ls-list-machines) to see when a machine reaches `ready` or `off`,
or why it `failed`. Through MCP, power commands wait and report the resulting
state, including the reason for a failure or forced shutdown.

### `boot`: Start machines

```text
boot <machines>
```

Start machines that are off or failed using their existing disks. An off machine
keeps its ports. A failed machine releases its ports. To boot it again, you need
a free port for each interface that was plugged in when you created it.

MCP tool: `machines_boot`

With `node2` off, enter `boot node2`.

```text
booting node2
```

Wait for `ready` before typing in the terminal. If the machine fails again, read
the reason in its configuration.

### `reboot`: Restart machines

```text
reboot <machines>
```

Shut down ready machines and boot them again. Running programs and additional
shells end. The machines keep their names, disks, cables, and addresses set by
the lab. Mounts and addresses you set in a shell need to be set again unless you
configured Linux to apply them at boot.

MCP tool: `machines_reboot`

With `node2` ready, enter `reboot node2`.

```text
rebooting node2
```

The machine goes through shutdown and boot before it becomes ready again.

### `poweroff`: Shut down machines

```text
poweroff <machines>
```

Shut down ready machines to release their memory and keep their disks for
another boot. Wait for a checkpoint save to finish before shutting down.

MCP tool: `machines_poweroff`

With `node2` ready, enter `poweroff node2`.

```text
powering off node2
```

The machine saves pending disk writes before it reaches `off`. If the save
fails, open the machine's configuration to read the reason.

## Machine removal

Remove a machine when you have finished with its files. To keep them for later,
[power it off](#poweroff-shut-down-machines).

### `rm`: Remove machines

```text
rm <machines>
```

Remove the named machines from the lab and free their switch ports.

MCP tool: `machines_remove`

> [!WARNING] Removing a machine permanently deletes all of its disks and
> [checkpoints](storage-and-checkpoints.md#checkpoints).

If you have finished with `node2`, enter `rm node2`. Review the machine name and
disks in the confirmation, then confirm the removal.

```text
removed node2
```

The machine disappears from the rack and its terminal windows close.
