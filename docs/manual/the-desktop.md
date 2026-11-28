# The desktop

Use the desktop to see what is in the lab, open a terminal, or follow the cables
between machines. Select the logo at the top left to open the lab menu. From
there you can reopen **Rack manager** or **Topology**.

## Rack manager and configuration

**Rack manager** lists machines and switches. Select a machine name to open its
**Configuration** window, or select the terminal icon beside the name to type on
the machine. The configuration shows the machine's power state, any boot
failure, the image, CPUs, memory, disks, and network interfaces. See
[Machines](machines.md) for the settings you choose at creation.

Select a switch in the rack to open **Switch details**. Its port rows show where
each cable goes. See [Networks](networks.md) for port settings and traffic
counters.

## Topology

**Topology** shows machines and switches with their cables. Open it from the lab
menu. Follow a line from a machine to the port on its switch, or between the two
ends of a switch cable. Select a machine or switch to inspect it. Right-click
the device to open its menu.

## Terminals and shells

Open a terminal to type shell commands on a machine. The first terminal shows
the console, where Linux prints its boot messages and starts a shell. An
additional shell lets you keep a program running in one terminal and type in
another. Right-click a ready machine in the rack and select **New terminal**.

Each shell has a session name. For a machine named `node2`, the console is
`node2:console` and the first additional shell is `node2:sh1`. To return to that
shell, enter [`focus node2:sh1`](#focus-select-a-terminal) in the command bar.
The inventory from [`ls`](machines.md#ls-list-machines) lists the sessions on
each machine.

Closing a terminal window leaves its shell running. Exiting an additional shell
ends that session. Rebooting a machine ends its running shells. When you reload
the lab, the desktop opens fresh shells only for the additional terminal windows
you left open or minimized.

### `sh`: Open another shell

```text
sh <machine>
```

Open an additional shell on a ready machine and move the keyboard to it. Use
this command in the browser's command bar.

With `node2` ready and no additional shell opened on it yet, enter `sh node2`.

```text
opened node2:sh1
```

The window shows the new shell prompt. Later shells get higher numbers. To
return to a shell that already exists, use [`focus`](#focus-select-a-terminal).

### `focus`: Select a terminal

```text
focus <machine or session> [--main | --max]
```

Bring the terminal you last used on a machine to the front, or select a session
by name. Enter the command in the browser's command bar. If the machine is
ready, you can type in the terminal immediately.

| Option   | Meaning                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--main` | Bring the terminal forward. In the classic tiled layout, put it in the first position. With three terminals in two columns, that position fills the left column. |
| `--max`  | Maximize the terminal, or restore its size if it is already maximized.                                                                                           |

With `node2` ready, enter `focus node2:console`.

```text
focused node2:console
```

The console comes forward even if an additional shell was active. If a named
shell has exited, choose one of the sessions that still exists.

## Window arrangement

Drag a title bar to move a window. Drag an edge or corner to resize it. Drag the
title bar to the left or right edge of the desktop for a half-width window, or
to the top to maximize it. Double-click the title bar to switch between the
maximized and previous sizes.

Use **Minimize** to put a window in the dock. Select its dock button to bring it
back. To bring back a specific shell after closing its window, use
[`focus`](#focus-select-a-terminal) with its session name. The browser remembers
the desktop layout for your next visit in the same profile.

## Notes

Choose **New note** from the lab menu to write down an address, a shell command,
or an observation. Each note has its own window. Its text is saved with the
desktop layout as you type. Minimize the window to keep the note for later.
Closing the note removes it.
