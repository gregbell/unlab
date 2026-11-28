# Storage and checkpoints

Files you save on a machine's disk stay in the browser. Add a blank disk when
you need a separate filesystem. Save a checkpoint before changing files you
might want back.

## Disk sizes

Choose the disks in **Storage** when you
[create the machine](machines.md#machine-creation). Set **Root disk · /dev/wdb**
to the capacity you need. The writable root disk, `/dev/wdb`, holds the
machine's own files. Linux also sees the read-only image as `/dev/wda`. Choose
4, 8, 16, 32, or 64 GiB for the writable disk. The default is 4 GiB. The disk
capacity is the space Linux can use. A fresh machine does not immediately use
that much browser storage.

## Additional disks

Each machine can have up to four additional disks. Each starts blank and holds 1
to 64 GiB in whole GiB. In the machine wizard, **Storage** has a **+ Disk**
button. It shows the Linux device name beside the size of each disk.

| Disk                   | Device     |
| ---------------------- | ---------- |
| Writable root disk     | `/dev/wdb` |
| First additional disk  | `/dev/wdc` |
| Second additional disk | `/dev/wdd` |
| Third additional disk  | `/dev/wde` |
| Fourth additional disk | `/dev/wdf` |

To try a new filesystem, you need room for one more machine and the name `files`
must be free among both machines and switches. This example uses the `lab` image
because it includes the disk utilities.

1. In the lab menu, choose **Add machines…**. Set **Machines** to one, choose
   the `lab` image, and enter `files` in **Hostname**.
2. Under **Storage**, select **+ Disk**. The first additional disk appears as
   `/dev/wdc`, with a size of 1 GiB. Under **Network**, choose **Unplugged** for
   `eth0`. This machine can work with its disks offline.
3. Select **Review**, then **Boot 1 machine**. Select `files` in **Rack
   manager**. Under **Storage**, check that `/dev/wdc` has a capacity of 1 GiB.
4. When the machine is ready, open its terminal. Enter
   `lsblk -ndo NAME,SIZE /dev/wdc` to check the disk against the configuration.

   ```text
   wdc    1G
   ```

   > [!WARNING]
   >
   > Formatting a disk deletes its files. Continue only if `/dev/wdc` is the
   > blank 1 GiB disk you added.

5. In the terminal on `files`, enter `sudo mkfs.ext4 -q /dev/wdc` to create an
   ext4 filesystem.

   ```text
   files ~ ⇒
   ```

   The shell prompt returns when the format finishes. Its text can vary.

6. Enter `sudo mount /dev/wdc /mnt && df -P /mnt`. Linux mounts the disk at
   `/mnt` and shows which device supplies that directory.

   ```text
   …
   Filesystem           1024-blocks    Used Available Capacity Mounted on
   /dev/wdc                996780       280    927688   0% /mnt
   ```

   The space figures depend on the filesystem. Files written under `/mnt` now go
   to `/dev/wdc`. After a reboot, mount the disk again to use its files. Format
   it only the first time.

To create the same machine from the command bar, use
[`spawn`](machines.md#spawn-create-machines) with `--extra-disk`. With the name
`files` available, enter `spawn 1 lab --name files --no-net --extra-disk 1`.

```text
booting files
```

## Browser storage

Reopen the lab in the same browser profile to recover its disks, network, and
desktop layout. Machines that were running boot again with the files on their
disks. Reloading ends running programs and shell sessions. If you mounted a disk
by hand, mount it again to use its files. A machine that was off stays off.

A checkpoint uses the same browser storage as the lab. Clearing the site's data
deletes both. [Removing a machine](machines.md#machine-removal) also deletes
every checkpoint of that machine.

## Checkpoints

A checkpoint saves all writable disks of one machine under a name. It contains
the files on those disks, including files on additional disks. Running programs,
RAM, and the lab's switch and cable settings are outside the checkpoint.

In the command bar, [`ls`](machines.md#ls-list-machines) lists the checkpoints
under each machine with their sizes in MiB. The size measures the saved disk
blocks. It can be much smaller than the capacity of the disks. Each checkpoint
needs space for its own copy.

### `checkpoint`: Save disks

```text
checkpoint <machine> <checkpoint>
```

Save the disks of a ready machine or one that is off. A ready machine continues
to run. Start the checkpoint name with a lowercase letter. Use up to 63
lowercase letters, digits, or hyphens and end with a letter or digit. Choose a
name the machine has not used for another saved checkpoint.

MCP tool: `checkpoint_save`

With `node2` ready or off and the name `before` free, enter
`checkpoint node2 before` in the command bar.

```text
saving before of node2
```

Wait until the checkpoint appears with a size in
[`ls`](machines.md#ls-list-machines). The MCP tool waits for the save and
returns the byte count. If the browser runs out of room, the save fails and the
machine keeps its disks.

### `restore`: Restore disks and boot

```text
restore <machine> <checkpoint>
```

Restore a ready, off, or failed machine from one of its checkpoints. A
successful restore boots the machine, even if you saved the checkpoint while it
was off. You can restore the same checkpoint again.

MCP tool: `checkpoint_restore`

> [!WARNING]
>
> Restoring stops the machine and discards everything written to its disks since
> the checkpoint. Save another checkpoint first if you need those files.

If `node2` has a checkpoint named `before`, enter `restore node2 before` in the
command bar and confirm the restore.

```text
restoring node2 to before
```

The machine passes through `restoring` and `booting`. The MCP tool waits until
the machine settles. If the lab cannot copy the checkpoint back, the machine
shows `failed` and keeps its previous disks. The checkpoints remain available.

### `forget`: Delete a checkpoint

```text
forget <machine> <checkpoint>
```

Free the storage used by one checkpoint. The machine keeps its current files and
its other checkpoints.

MCP tool: `checkpoint_remove`

> [!WARNING]
>
> After you delete a checkpoint, you cannot restore the machine to that copy.

If `node2` has a checkpoint named `before` that you no longer need, enter
`forget node2 before` in the command bar and confirm the deletion.

```text
deleted checkpoint before of node2
```

If a restore is using that checkpoint, wait for the restore to finish and try
again.
