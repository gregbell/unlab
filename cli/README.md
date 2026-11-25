# unlab.run

Reach the machines of an [unlab](https://unlab.run/) lab from your terminal. The
lab is real Linux machines in a browser tab. This links them with your computer.

```sh
npx unlab.run
```

```
Linked to the lab: node1 (alpine), node2 (debian)
unlab> ssh node2
user@node2:~$ curl -sI https://example.org | head -1
HTTP/2 200
```

You need Node.js 22.12 or later, OpenSSH, and Chrome or Chromium 150 or later, on
Linux or macOS. The browser asks once whether the lab may reach apps on your
device.

While it runs:

- `ssh <machine>` opens a shell in any machine, and `ssh <machine>.unlab`, `scp`
  and `rsync` work from any terminal.
- Machines that have a gateway reach the internet through this computer.
- Every lab command works at its prompt, and from a shell:
  `npx unlab.run exec node1 -- uname -a`.
- `forward <machine> 8080:80` makes a machine's port one of this computer's.

[The lab's README](https://github.com/gregbell/unlab#reach-the-lab-from-your-terminal)
has the rest. `npx unlab.run --help` lists the options.
