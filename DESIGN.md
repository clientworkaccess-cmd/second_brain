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
  and opening a page opens its folder.
- **Centre:** a tab for every page that is open, kept for as long as the browser tab is.
- **Right:** backlinks, outline and links for a page. Activity and a summary for a cluster.
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

One colour per folder: the hues are spread by the golden angle over the folder
names in alphabetical order, at 62% saturation, lighter on dark. That is the
desktop app's rule, so the same wiki gets the same kind of colours in both.
A link to a page that does not exist is drawn faint and dashed. Past 120
pages only the thirty best-connected keep their labels, and whatever is under
the pointer with its neighbours.

The desktop app draws with WebGL, because a vault reaches thousands of links.
This app draws SVG, because a cluster reaches tens to low hundreds of pages.
