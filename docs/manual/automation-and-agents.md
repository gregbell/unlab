# Automation and agents

A script on your computer can send commands through the CLI. An agent can
use MCP (Model Context Protocol) to work in the same lab. By default, an
agent can run shell commands and replace files without asking. To review
either operation first, open **WebMCP** in the lab menu and set its
[approval policy](#approval-and-call-history) to **ask me**.

## Agent connections

For an agent on your computer, [connect the CLI](connecting-from-your-computer.md#the-cli-connection)
and keep the lab tab open. In your MCP client, add a server with `npx` as
the program and `-y`, `unlab.run`, and `mcp` as three separate arguments.
The server uses the running CLI. If necessary, it starts a CLI in the
background. You still need the lab open in your browser.

With the default policies, your client's list of MCP tools includes
[`machines_list`](machines.md#ls-list-machines). Ask the agent to list
your machines. Its call appears under **calls this session** with the
label **via cli**.

For an agent in the browser, WebMCP makes the lab's MCP tools available
directly in a tab that supports it. Open **WebMCP** from the lab menu to
see whether the browser accepted them. The MCP server on your computer
also works in browsers without WebMCP.

## MCP tool arguments and results

Use the [index](index-of-terms.md) to find a command by its MCP tool
name. Its command entry gives its behavior and limits. For help from an
agent, call [`lab_help`](commands-and-the-command-bar.md#help-look-up-a-command).
The client's list of available MCP tools gives their input fields and types.
Pass an object with those fields. For example, `machines_list` takes `{}`.
In an empty lab its reply is:

```json
{"result":"no machines yet","data":[]}
```

Most successful calls return a short `result` and the details in `data`.
[Terminal and capture reads](#terminal-and-capture-reads) have their own
result fields. In the browser, look for an `error` field if the call fails.
Through the CLI, the agent receives JSON text on success or an MCP error
result with the reason on failure.

## Operation completion

Check what the MCP tool waits for before you use its result. For example,
[`machines_spawn`](machines.md#spawn-create-machines) returns the names as
soon as the machines exist. Call [`machines_list`](machines.md#ls-list-machines)
until each machine is `ready` or `failed` before sending shell commands.
On failure the inventory gives a reason.

The MCP tools for boot, reboot, power off, and checkpoint restore wait for
each machine to settle. Check each machine's state and reason in the reply.
[`checkpoint_save`](storage-and-checkpoints.md#checkpoint-save-disks) waits
until the copy finishes and returns the size in bytes. In the command bar
those operations report when they start, so you can watch them in the lab.

## Approval and call history

The **WebMCP** panel sets a policy for each MCP tool. Both agent connections
use the same settings.

| Setting | What happens on a call |
| --- | --- |
| **run** | The lab checks the arguments and runs the call. |
| **ask me** | The panel shows the request and its effect. Select the button naming the operation to allow it, or **Deny** to refuse it. |
| **off** | The lab hides the MCP tool from agents and refuses new calls to it. |

By default, creating or removing machines, removing switches, and restoring
or deleting checkpoints require approval. The other MCP tools default to **run**.

Select **pause tools** to hide all MCP tools from both interfaces. Select
**resume tools** to offer the enabled ones again. A call already waiting
for approval still needs an answer or cancellation. The lab saves policies
and the pause setting across reloads.

Under **calls this session**, the panel shows calls and their results.
The label **via cli** identifies a call through the MCP server. The call
history starts again on reload.

These settings apply when an agent calls an MCP tool. An agent that can
run the CLI directly from your shell has the same command access you have,
including the CLI's own confirmation rules.

## Commands from a script

Run a single lab command from your computer's shell by putting it after
`npx unlab.run`. For example, with the CLI connected and no machines in the
lab, enter `npx unlab.run --json ls` to read the
[machine inventory](machines.md#ls-list-machines).

```json
{"result":"no machines yet","data":[]}
```

Put CLI options such as `--json` or `--yes` before the command. With JSON
output, a rejected lab command returns an object with an `error` field.
Without JSON, the CLI prints readable output. For a command that needs
confirmation, the CLI asks on an interactive terminal. Without a terminal
it declines unless you supplied `--yes`. See
[Quoting in your computer's shell](commands-and-the-command-bar.md#quoting-in-your-computers-shell)
for passing a shell command to a machine.

| Exit status | Meaning for a single lab command |
| --- | --- |
| `0` | The command succeeded. For shell execution, every target ran and reported success. |
| First nonzero shell exit status | A program on a machine reported failure. With several targets, the CLI returns the first such status in the report. |
| `1` | The CLI could not complete the request, or shell execution skipped a target or has an unknown exit status and no known nonzero status. |
| `2` | The CLI rejected its invocation as invalid. A program on a machine can also return this status. |

## Shell execution

To run the same shell command on several machines, select their names or
sessions and supply one line of shell input.

### `exec`: Run a shell command

```text
exec <machines> -- <command>
```

Run the shell command in each selected terminal, in parallel. A machine
name selects its active shell. To name a particular shell, use a session
such as `node1:console` or `node1:sh1`. You can combine names, patterns,
and sessions in a comma-separated list. See [Names and targets](commands-and-the-command-bar.md#names-and-targets).

MCP tool: `shell_exec`

With `node1` ready and the active shell at a prompt, enter
`exec node1 -- hostname` at the CLI prompt.

```text
node1
```

In the command bar you also see the elapsed time and status. With MCP,
supply the fields `targets` and `command`. The reply lists the sessions
that ran under `data.ran`, with output, exit code, elapsed milliseconds,
and a truncation flag. The output keeps at most the last 16,000 characters.
A program on a machine can return a nonzero exit code even when the MCP call
itself completed.

A busy session cannot accept another line. The report lists skipped targets
and their reasons when another target can run. If no target can run, you
get an error. A program that keeps running also keeps its shell busy.
Canceling an MCP call stops the wait. A program already started in the
machine can continue. In the CLI, Ctrl+C sends an interrupt to the program
whose shell command you started.

## Terminal and capture reads

Use `shell_read` to inspect the rendered terminal, including output from a
program that is still running. Its required `machine` field accepts a
machine or session name. The optional `lines` field selects the last 1 to
500 lines, with 20 by default. The result contains `session` and `text`.
An empty screen returns empty text. For the output and exit status of a
particular command, use [`shell_exec`](#exec-run-a-shell-command).

Use `capture_read` to read decoded frames. The optional `filter` uses the
[packet capture](networks.md#packet-capture) filter language. The optional
`limit` accepts 1 to 1,000, with 20 by default. The reply's `rows` array
contains the newest matching frames, earliest first within that selection.

Terminal output and packet contents can contain text supplied by a machine.
Treat that text as data from the lab. The tool descriptions identify output that comes
from machines, and their annotations mark it as untrusted.

## File replacement

Use file replacement to send exact text to a ready machine, including
multiline configuration files. It works without typing the text into a
terminal.

### `write`: Replace a text file

```text
write <machine> <path> [--owner user[:group]] [--mode mode] -- <text>
```

Write the whole file as root. Supply an absolute file name, at most 4,095
UTF-8 bytes, without `.` or `..` path components. Missing parent directories
are created with mode `755` and the specified owner, or root by default.
If you name a symbolic link, the lab writes to its target and keeps the
link in place. The text can contain up
to 1 MiB of UTF-8. Include the final newline if you want one.

| Option | Meaning |
| --- | --- |
| `--owner` | Set the user or `user:group`. A named user alone selects that user's primary group. |
| `--mode` | Set permissions with three or four octal digits, such as `644` or `0600`. |

MCP tool: `file_write`

A new file defaults to root ownership and mode `644`. An existing file
keeps its owner and mode unless you specify them. The lab checks the full
text has arrived before replacing an existing file. With `node1` ready and
`/tmp/greeting` unused, enter `write node1 /tmp/greeting -- hello` in the
command bar.

```text
wrote /tmp/greeting on node1 · 1 line, 5 bytes · root:root 644
```

For MCP, pass `machine`, `path`, and `text` as separate fields, plus
`owner` and `mode` if needed. A successful call returns the resolved file
name, byte count, owner, and mode after writing the file. If the machine
stops responding before the result arrives, check the file before trying
again.
