# Commands and the command bar

Use the command bar to tell the lab what to do. Use a machine's terminal to give
Linux a shell command. The
[CLI prompt](connecting-from-your-computer.md#the-cli-connection) also accepts
commands for the lab.

## Command syntax

The first word names the command. Give the arguments in the order shown in its
[synopsis](introduction.md#conventions). Separate words with spaces.

An option starts with two hyphens. An option that needs a value takes it as the
next word, as in `--mem 512`. Options can appear between positional arguments or
after them. Give an option once. Where the synopsis offers alternatives in the
same brackets, choose at most one.

For `exec` and `write`, a separate `--` marks the end of the lab's arguments.
Before it, use a backslash to put a space in a file name, as in
`/tmp/my\ notes`. Type two backslashes for one backslash in a file name. Shell
quotation marks do not group words here.

For [`exec`](automation-and-agents.md#exec-run-a-shell-command), enter the shell
command after `--`. Use pipes, redirects, and quotes as you would in the
machine's terminal.

For [`write`](automation-and-agents.md#write-replace-a-text-file), enter a space
after `--`, then the file contents. The lab keeps any additional spaces. The
command bar takes one line. An agent can supply file contents with line breaks.

## Quoting in your computer's shell

When you invoke the CLI from your computer's shell, that shell reads the line
first. Quote a machine pattern such as `'db*'` so the lab receives the asterisk.
To run a pipeline inside a machine, pass the whole pipeline as one quoted
argument after `--`.

For example, if a machine named `node1` is ready and its active shell is at a
prompt, run this on your computer:

```sh
npx unlab.run exec node1 -- 'hostname | tr a-z A-Z'
```

```text
NODE1
```

The output is the machine's hostname in uppercase. The quotes belong to your
computer's shell. In the command bar or at the CLI prompt, enter the pipeline
after `--` without those outer quotes.

## Names and targets

The argument in the synopsis tells you what kind of name to enter.

| Argument          | Example                      | Meaning                                                                                                                                                                            |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine           | `node2`                      | One machine. Use its assigned name or the name you chose at creation.                                                                                                              |
| Machines          | `node1,db*`                  | A comma list with no spaces. An asterisk matches zero or more characters in a machine name. Use `all` for every machine.                                                           |
| Shell session     | `node2:console`, `node2:sh1` | The machine's main console or a particular additional shell. The machine name alone selects its active shell, initially the console. Selecting a terminal makes that shell active. |
| Network interface | `node2:eth1`                 | The machine and its second network interface. Interface numbers start at zero.                                                                                                     |
| Switch            | `switch0`                    | The switch every new lab starts with. Use another switch's name to select it.                                                                                                      |
| Switch port       | `lan:3`                      | Port 3 on the switch named `lan`. Port numbers start at one.                                                                                                                       |

A selection can include machines in different states. For example, a boot
request applies to machines that are off or failed. The lab skips machines that
the command cannot use in their current state and reports the reason. If none
qualify, the command stops. A name that does not exist or a pattern with no
matches makes the whole selection invalid.

## Command bar keys

Click the command bar or press Command+K on macOS or Ctrl+/ elsewhere. The empty
bar shows commands and up to three recent lines, newest first. As you type, the
bar suggests values for the word at the cursor. The preview shows what the
completed line would do in the current lab, including defaults.

| Key                         | Effect                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab                         | Insert the selected suggestion. After an error, insert the suggested correction so you can edit it.                                                                             |
| Up, Down                    | Move between suggestions. From an empty line, Up recalls lines that you ran from the bar. Down moves forward through that history.                                              |
| Enter                       | Accept a suggestion or run the current line. The hint beside the input shows which. On an error with a suggested correction, take the correction and submit the corrected line. |
| Ctrl+Enter or Command+Enter | Submit the line and keep the bar open after a change you can see on the desktop.                                                                                                |
| 1 through 8                 | From an empty bar, focus the machine in that position in the [rack's list of machines](the-desktop.md#rack-manager-and-configuration), if available.                            |
| Escape                      | At a confirmation, return to the line. Otherwise close the bar.                                                                                                                 |

## Results and confirmation

Commands that return a list or a report keep it in the bar. Press Up to edit the
line or Enter to run it again. A command that changes the desktop usually closes
the bar so you can see the result.

When you remove a machine or restore a checkpoint, for example, the bar
describes what will change. Read the confirmation, then press Enter again to
proceed or Escape to keep editing. If the machines or the effect change before
you approve it, read the new confirmation. Closing the bar during a command
stops waiting for the result. Changes the lab has already made remain in effect.

## Commands in other interfaces

The CLI can run the same commands as the command bar. Commands that open windows
or change focus act in the browser, even when you enter them at the CLI prompt.
A packet capture saved from the CLI goes to the browser's downloads. The CLI
also has its own commands for SSH, forwarding, and connection status. See
[Connecting from your computer](connecting-from-your-computer.md).

An agent uses the Model Context Protocol (MCP) to call a tool by name. Each
command entry lists its MCP tool when it has one. Commands for opening shells,
focusing windows, and showing the packet capture have no corresponding MCP tool.
An agent can read terminal text and captured frames directly. See
[Automation and agents](automation-and-agents.md).

### `help`: Look up a command

```text
help [verb]
```

Enter `help` to list commands and a short description of each. To see a
command's syntax, arguments, defaults, and an example, give its name or the name
of its MCP tool. An unknown name produces an error with the available command
names.

MCP tool: `lab_help`

With any lab open, enter `help lab_help` in the command bar. The report starts
with the synopsis and ends with the corresponding MCP tool:

```text
help [verb]
…
agent tool  lab_help
```
