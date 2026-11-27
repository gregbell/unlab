# Story 3.2's last two boxes in the Topology window

The two boxes are "With 16 machines and eight switches, every name can be read" and "It can be used by keyboard, and
does not rely on color alone". This slice changes how the Topology window (`src/ui/desktop/topology.ts` and
`topology.css`) lays out its nodes, routes its lines, and marks selection and line state. The words in the window are
as on main.

## How it was seen

`look.mjs` builds each lab in the built app by typed commands, in Chromium, and saves the Topology window three ways:
as it opens at 1440 × 900, maximized, and in a browser window 480 wide. Beside each picture it prints what
`unreadable` finds. `unreadable` is in `test/support/topology.ts`, and the browser tests use the same function.

- `before/` and `results/before.txt` are the app at 5a25194, which was origin/main when this slice began. #51 has
  landed since, and changes none of the map's files.
- `after/` and `results/after.txt` are the app with this slice.

| Lab | What is in it |
| --- | --- |
| `crowd` | 16 machines on eight switches, three with names of 20 characters, VLANs, two trunks, a delayed cable, a storm from a switch cabled to itself, and a port that the spanning tree blocks. `edge` and `office` stand in one column and are cabled to each other. |
| `shared` | `router` on `switch0` and `lan`, which are cabled together, so `router` and `lan` share a column. |
| `wrap` | Names of 38, 35, 20 and 63 characters, one above the other. 63 is the longest a name can be. |
| `self` | `lan` cabled to itself twice. |
| `pair` | Four cables between `switch0` and `lan`. One carries, the spanning tree blocks two, and one is cut. A machine's cable is cut and a machine is off. `pair-selected-and-focused.png` has `lan` selected and `node1` with the keyboard's focus. |
| `chain` | Eight switches in a row, nine columns, wider than the window as it opens. |
| `islands` | A switch with nothing in it and two unplugged machines. |

`look.mjs` checks 25 pictures. At origin/main, 10 of them had every name and note readable. With this slice all 25 have.

## What is wrong on main, and why three fixes of the note failed

Story #45 failed review three times on a note that ran under the node below. Each fix kept one premise: the script
places every node at a fixed pitch (`rows * 116`) and assumes how tall a label is. The same premise is behind what
`before.txt` finds.

- A name that wraps to three lines runs under the next node (`before/wrap-open.png`).
- Every line runs from the centre of one node to the centre of the other, so a line that goes steeply down crosses the
  name under the node it leaves (`before/crowd-max-tall.png`, `internal-router-east`).
- Two cabled nodes in one column are joined by a straight line through the upper one's name (`before/shared-open.png`,
  `router`).
- Nine columns are pressed into the window, with no room left for a line (`before/chain-open.png`).

This slice removes the premise. The browser lays the nodes out, and the script then draws the lines to where the nodes
are.

## The layouts tried

| Layout | What it is | What the pictures show |
| --- | --- | --- |
| A, plates | Main's layout with a pitch counted from the letters in each label, a dark plate behind each name as the tag on a faceplate's cable has, and a bow for a cable inside one column. `sketches/a-plates.patch` applies to 5a25194. | `unreadable` still finds lines across names in `crowd` and `wrap`. Lines vanish behind the plates, and the plates make the map heavy (`sketches/a-plates/crowd-open.png`, `wrap-open.png`). The count of letters is wrong in a narrow window, where a label is 80 px wide (`wrap-narrow.png`). |
| B, columns and channels | Each node is a tile with its name under it, as on main. The nodes of a column are laid out by CSS, so a label takes the height it needs. A line leaves its column level with its own tile and changes height only in the clear channel between two columns. | Every picture is clean (`after/`). The look of main is kept. With 16 machines the map scrolls one way, down, in the window as it opens. |
| C, cards | The same columns and channels, with each node a card that has its name beside its art, as a row of Rack manager has. `sketches/c-cards.patch` applies to this slice. | Every picture is clean, and all 16 machines fit a maximized window without scrolling (`sketches/c-cards/crowd-max.png`). A card is about 230 px wide, so four columns scroll both ways in the window as it opens (`crowd-open.png`), and a narrow window needs a second layout (`crowd-narrow.png`). It replaces the tiles that Topology has had. |

B is the one built. It passes the check everywhere, keeps the map's look, and needs one layout for every width. C is
the option to take if the map should show more nodes at once and may change its look.

Two treatments of the selected node were tried on B, in `sketches/selection/`.

- `frame-twice-as-thick.png`: the tile's frame is 2 px and the name is heavier. This one is built.
- `bar-under-the-tile.png`: a 3 px bar along the tile's lower edge, as a selected terminal tab has, and a heavier name.
  It reads as a tab, and the tile is not one.

## What is reused from the rest of the app

| What the map shows | How | Where the app already does it |
| --- | --- | --- |
| A selected node | The tile's frame in `--machine-hue` or `--agent` and its tint, as on main. New are the frame at twice the width and the name at weight 600. | `.dt-window[data-active="true"]` gives the active window a heavier title (`--dt-title-weight`). `unlab-pane[focused]` and `.choice[aria-pressed="true"]` mark the chosen one by its frame. |
| The keyboard's focus | The ring of `:focus-visible` in `base.css`, 2 px of `--agent` at an offset of 2 px. It is round the whole button, which is the tile with its name and note. | Every button of the app. |
| A cut cable | Dashed and `--down`, as on main. | `.port[data-state="cut"] .cable` on a switch's faceplate. |
| A machine that is off, booting or stopping | Dotted. Off was dotted on main. Booting and stopping were solid. | `.port:is([data-state="booting"], [data-state="stopping"]) .cable` on the faceplate. |
| A blocked or learning port's cable | New dashes in the colour of a cable in use: a dash and a dot for blocked, long dashes for learning. Main drew both as a cable in use. | The faceplate says both in words on the cable's tag. The map keeps the words in the node's title and description, and adds the dashes. |
| Sizes, colours and type | `--r-panel`, `--mantle`, `--base`, `--line`, `--text-3`, `--fs-input`. No new token and no new colour. | `tokens.css`. |

The app has one theme. `tokens.css` sets `color-scheme: dark` and has no light values, so there was no second theme to
check.

## Box by box

| Box | Tests in `src/ui/desktop/topology.browser.test.ts` | Seen red |
| --- | --- | --- |
| With 16 machines and eight switches, every name can be read | "every name and note in the Topology window can be read", five labs in each of three sizes. `unreadable` fails a name or a note that a line crosses, that another node's tile, name or note is over, that a box cuts off where no scrolling reaches, or that is not drawn. Each test also needs every line to end inside the tiles of its two nodes. | `results/red-on-main.txt`: 11 of these 15 are red on main's map. `results/red.txt`: nine breaks of the layout, each red. |
| It can be used by keyboard | "can be used by keyboard". Tab reaches every node, in the order they are drawn. Each has a ring of 2 px or more while it has the focus. Enter and Space select the node and open its window. | Red on main, where Tab went by the lab's order and not the picture's. `results/red.txt`: five breaks. |
| It does not rely on color alone | "says a selected node and each line's state by more than its colour". The test sets every colour token to one grey. It then needs the selected tile and name to be drawn unlike another's, the five line states to have five different dashes, and a selected node's line to be thicker. | Red on main, where the selected tile differed in colour only. `results/red.txt`: seven breaks. |

`red.mjs` makes each break of `breaks.mjs` in the source, runs the tests named for it, and puts the source back.
`red.mjs --main` puts the four files of the map back to 5a25194 under today's tests.

## What changed besides

- Tab goes through the nodes column by column, as they are drawn. On main it went through the switches and then the
  machines, in the lab's order.
- A selected node's lines are 3 px wide. They were 2.4 px, which is hard to tell from 2 px without the colour.
- The fade at the map's top and bottom is 16 px deep, as deep as the padding, so nothing is faded when the map is
  scrolled to an end. On main it was 5% and 4% of the window's height with 6 px and 10 px of padding, so it reached the
  last row's notes, and in a tall window the first row's tiles.
- `e2e/desktop-cables.spec.ts` and `e2e/spanning-tree.spec.ts` find a line by its box. Their helpers now measure from
  the node's tile, and allow 12 px where they allowed 10, for the thicker selected line.

## What was not changed

- The words. Each node's name, note, title and description are as on main.
- No word is drawn on a line. A tag that says `blocked` on the cable, as the faceplate has, is the next step if the
  dashes are not enough. It needs a rule for two tagged lines that run side by side.
- Arrow keys do nothing in the map. Tab reaches every node.
