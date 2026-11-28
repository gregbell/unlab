# Manual style guide

How to write the <https://unlab.run> Manual. Terms come from
[GLOSSARY.md](../../GLOSSARY.md); this guide covers everything else.

## Audience and scope

The reader can type commands into a terminal, but needs no prior experience with
<https://unlab.run> or networking. Explain product terms and expected command
results. General Linux and networking lessons belong in the
[Exercises](../exercises/).

Coverage follows the product into the guest far enough to make a feature usable,
and stops there. A minimal guest example is in scope when the feature is useless
without it: an additional disk is shown through formatting and mounting. Purely
Linux topics, and surveys of alternative Linux techniques, are out of scope.
Running or self-hosting <https://unlab.run> stays in the README.

Getting started is the one guided sequence. Every other chapter stands alone: it
relies on no machine, file, or other state created in another chapter, and each
example states its own prerequisites.

## Words

- Use the glossary's terms, and none of the words it lists under _Avoid_.
- In reader instructions, use "command" and say where to enter it when needed:
  in the command bar or at the CLI prompt. For a shell command, name the machine
  whose terminal to use.
- Use the product's names for things exactly as the screen and the CLI show
  them, even where the glossary would prefer another word. When the product's
  wording conflicts with the glossary, write what the screen says and open an
  issue (see [When the product looks wrong](#when-the-product-looks-wrong)).
- Introduce a glossary term when the reader needs it. When the reader is
  choosing what to boot, for example, name the choices: Alpine or Debian. Define
  each specialised term you use where it first appears in a chapter. Chapters
  stand alone, so a term defined in another chapter is defined again, briefly,
  or linked.
- Write "file name", not "pathname"; "invalid", not "illegal".
- Use US spelling in prose. Quote UI text exactly, whatever its spelling.
- Write the product name in prose as <https://unlab.run>.

## Voice

- Address the reader as "you". Write present tense, active voice, short
  sentences.
- Speak for the product. State a recommendation directly: "Save a checkpoint
  before you change a disk."
- Say what a feature is good for, and when to choose something else.
- Explain why only when the reason changes what the reader does.
- Describe the product as it is today. Plain, exact verbs; no marketing, no
  trendy wording, and no "simply", "just", or "easy".

## Chapter shape

- A chapter is organised by the jobs a reader has in mind, from the basic to the
  specialised. At each point, address the most important question the preceding
  text raises.
- Open with a paragraph saying what the chapter's subject is. Follow it with any
  rule that holds for the whole chapter, stated once (for example, how Networks
  writes interface and port names).
- Each topic has one owning chapter. Other chapters link to it rather than
  repeat it. Link liberally.
- Keep sections short. Split a section as soon as it covers two jobs.
- Start every section with a one-sentence summary.

A chapter holds two kinds of section.

### Subject sections

A subject section explains one subject. Its heading is a noun phrase a reader
would look up: "Cable conditions", "Package gateway". Inside it, explanation
comes first, then any procedure, then reference tables (options, limits,
states).

### Command entries

A command entry is the one definitive description of a command. It sits in the
chapter that owns the command's subject, and every other mention links to it.

````markdown
### `mkswitch`: Add a switch

```text
mkswitch [name]
```

What the command does, what it is for, and when to choose something else.

| Option | Meaning |
| ------ | ------- |
| …      | …       |

MCP tool: `switch_add`

Example, with its output, then what the command reports when it finishes or
fails.
````

- The heading is "`command`: Summary", the summary in a few words.
- The synopsis is exactly the usage `help <command>` prints. The Introduction's
  Conventions section explains the notation: `<placeholder>`, `[optional]`,
  `a | b`, `-- <command>`.
- Name the command's MCP tool in one line, if it has one. MCP tools get no
  entries of their own; the Automation chapter describes the few with no
  command.

## Procedures

- A task of three or more actions is a numbered list of imperative steps. After
  each step, say what the reader sees.
- A task of one or two actions is a sentence.

```markdown
1. In the Rack manager, select **Open capture**.

   A **Capture · switch0** window opens and lists frames as they cross `switch0`.
```

## Examples and output

- Follow every command example with its expected output in a block.
- Mark elided output with `…`.
- After the block, name the values that vary from lab to lab: addresses, sizes,
  times, counters.
- Output printed by the guest (`ping`, `apk`, `apt`) is illustrative: show a
  typical run and say which parts vary.

## Formatting

| What                                               | How                        | Example                    |
| -------------------------------------------------- | -------------------------- | -------------------------- |
| Text on screen: buttons, window titles, menu items | **Bold**, exactly as shown | **Boot 2 machines**        |
| Anything the reader types or the product prints    | `Code`                     | `plug node2 lan:1`         |
| Names of machines, switches, interfaces, files     | `Code`                     | `node1`, `eth0`, `~/notes` |
| Keys                                               | Words                      | Enter, Ctrl+K              |
| Placeholders in a synopsis                         | `<angle brackets>`         | `<machine>`                |

- Use a `> [!WARNING]` callout only before an action that loses data: removing a
  machine or its disks, restoring a checkpoint, removing a switch. Write every
  other note as ordinary prose.
- Use no screenshots. Name the UI in text.
- Use tables for reference (options, limits, states) and for troubleshooting
  (what you see, what to do).

## Links and anchors

- Link with relative paths: `[cable conditions](networks.md#cable-conditions)`.
- GitHub builds an anchor from the heading text, so renaming a heading breaks
  every link to it. When you rename a heading, find and fix every link to its
  old anchor in `docs/`, `README.md`, and `cli/README.md`.

## Files

- Each chapter is one file in `docs/manual/` with an unnumbered slug name:
  `getting-started.md`, `networks.md`.
- [README.md](README.md) lists the chapters in reading order, each with a
  one-line summary. Update it when a chapter is added, removed, or retitled.
- [index-of-terms.md](index-of-terms.md) is the one combined index: commands,
  MCP tools, glossary terms, UI names, and concepts, each under every wording a
  reader might look for ("cable, cutting" and "cutting a cable"), linked to its
  section. Update it whenever a section is added, renamed, or removed.
- `e2e/manual-getting-started.spec.ts` follows Getting started step by step, as
  a reader would. Change it in the same commit as any change to Getting started.

## When the product looks wrong

The Manual describes the product as it is. When the product itself seems wrong
(wording that breaks the glossary, a missing control, behaviour that contradicts
its own help), write the Manual against the current product and open a
`needs-triage` issue describing the problem, following
[the tracker guide](../agents/issue-tracker.md). Change product code only when
the task asks for it.
