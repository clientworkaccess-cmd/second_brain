# Second Brain: how it looks, and why

The web app and the Second Brain desktop app are one product in two places.
Someone who knows one should be at home in the other without being told.

That is the whole brief. Everything below follows from it.

## Where the look comes from

| Part | Source |
|---|---|
| Colours, fonts, sizes, radius | The desktop app's `theme.css`, value for value. Here: `src/app/theme.css` |
| Frame, tree, tabs, status bar, reading view, graph chrome, search panel | The desktop app's stylesheets, carried over with their class names. Here: `src/app/globals.css` |
| Upload, plan review, chat, the wizard, sign-in | Only this app has them. Built from `src/components/ui.tsx` with the same tokens |
| The mark | The desktop app's icon, as a vector in `src/components/Logo.tsx` and as `src/app/icon.png` |
| The editor | The desktop app's editor, its live preview and its toolbar, carried over with their class names. Here: `src/editor/` and the editor rules in `src/app/globals.css` |

When the desktop app changes a token or a rule that is in the first two rows,
change it here too. When this app needs a rule the desktop app does not have,
write it with the tokens and keep it out of those shared sections.

## Tokens

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg-primary` | `#ffffff` | `#1e1e1e` | The page and the centre pane |
| `--bg-secondary` | `#f5f5f5` | `#262626` | Sidebars, headers, cards, the status bar |
| `--bg-tertiary` | `#e9e9e9` | `#303030` | Buttons, pills |
| `--border` | `#dcdcdc` | `#383838` | Every line |
| `--text-normal` | `#222222` | `#dcddde` | Text |
| `--text-muted` | `#6f6f6f` | `#9b9b9b` | Secondary text, icons |
| `--text-faint` | `#a3a3a3` | `#666666` | Counts, placeholders, file icons |
| `--accent` | `#0d9488` | `#2dd4bf` | The one thing a screen is for |
| `--link` | `#0f766e` | `#5eead4` | Links |
| `--danger` | `#d23f3f` | `#ff6b6b` | Errors |
| `--success`, `--warning` | `#08893e`, `#be6400` | `#4ade80`, `#fbbf24` | Filed, and findings that are not errors. Not in the desktop app |

Text is the system font. The frame is 13px, a page is 16px, the radius is 6px.

In Tailwind the tokens are `canvas`, `panel`, `raised`, `line`, `ink`, `muted`,
`faint`, `accent`, `link`, `danger`, `success`, `warning`, `hover` and `active`.
None of them names a colour. Tailwind's own palette is switched off, so
`text-red-500` does not exist here.

## Light and dark

The app follows the system. The reader can choose light or dark from the status
bar, and that choice is kept in the browser. A script in `layout.tsx` applies it
before the first paint.

## The frame

```
┌──────────────┬──────────────────────────────────┬──────────────┐
│ PAGES SEARCH │ ▢ Index │ Warehouse Team × │      │ BACKLINKS …  │
├──────────────┼──────────────────────────────────┼──────────────┤
│ ▾ Entities   │                                  │              │
│   Page       │            the page              │   the panel  │
│ ▾ Concepts   │                                  │              │
│   Index      │                                  │              │
├──────────────┴──────────────────────────────────┴──────────────┤
│ Returns  3 pages · 3 links        2 backlinks  theme  Sign out │
└────────────────────────────────────────────────────────────────┘
```

- The window does not scroll. The panes do.
- **Left:** the page tree and the search. On the front page, the clusters. The
  folders are the wiki's own; the pages beside the index come after them, the
  index first. A wiki of more than sixty pages opens with its folders closed,
  and opening a page opens its folder. Where the wiki has facets, a drop-down
  per facet above the tree narrows the tree and the search to one value; the
  choice stays for as long as the browser tab is.
- **Centre:** a tab for every page that is open, kept for as long as the browser tab is.
- **Right:** backlinks, outline and links for a page. For a cluster: the agent's activity, every filing with what became of it and an undo, and a summary with the one decision a person makes about it: whether a filing waits for approval.
- **The editor:** the page as the desktop app edits it. Toolbar above, the
  text filling the pane, Live or Source, the state of the save at the right,
  Done in the accent colour. A page that changed underneath shows a banner
  with the choice, never a dialog.
- **The check page:** the wiki held to its rules, grouped by what is wrong, each remark with a link to the page. Warning colour for what a person may want to look at, danger for what must go.
- **A page's properties:** the block at its top, as the desktop app shows it. A
  facet's values are chips that lead to every page sharing them. What the rules
  would change about the block is said under it, in the warning colour.
- **Callouts:** `> [!conflict]` and the other kinds are drawn as the desktop
  app draws them, a coloured bar and a title. Conflict is the warning colour.
- **Status bar:** the cluster and its size on the left, the page's own facts on the right.
- Under 900px wide the sidebars lie over the page and open from the tab bar.

## Rules

1. Surfaces are flat. A one-pixel border separates them. A shadow is only for what floats over the page.
2. The accent is for the primary action and for links. If two things on a screen are teal and neither is a link, one of them is wrong.
3. No entry animations. Things are there when the page is.
4. Section headings inside a pane are small, uppercase and muted, like the sidebar titles.
5. A state is said in words as well as in colour: "Filed", "Needs attention", "Discarded".
6. Every empty place says what is missing and what to do about it.
7. A class name of ours is never a Tailwind utility. The desktop app calls its outline `.outline`; here that is `.outline-list`, because Tailwind has an `outline` of its own.

`npm run check:design` holds the tokens against the table above and looks for
class names that collide.

## The graph

The desktop app's WebGL engine draws it here too (`src/graph/webglGraph.ts`,
that app's file as it is): links are one draw call and nodes another, so a
wiki of thousands of links draws at full speed, and the colours, the pies,
the labels and the regions are the same in both apps.

One colour per folder: the hues are spread by the golden angle over the folder
names in alphabetical order, at 62% saturation, lighter on dark. A link to a
page that does not exist is drawn faint. Labels are drawn for whatever is
under the pointer with its neighbours, for a highlighted value, and for
everything once zoomed in.

Where the wiki has facets, the header offers to group by them instead of by
folder, as the desktop app's area view does: one colour per value, a page with
several drawn as a pie, each value gathering its pages around a place of its
own with a soft disc and its name behind them. A row of the legend highlights
one value and dims the rest; Escape widens it again. The choice is remembered
per wiki.
