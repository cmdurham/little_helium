# Little Helium

Arc's **Little Arc** for [Helium](https://helium.computer) (and any Chromium browser):
quick links open in a small, minimal window you can read and dismiss, or promote
into a main window with one keystroke.

## Install

1. Open `helium://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Optional: make Helium your default browser so links from other apps go through it.

## Use

| Action | How |
| --- | --- |
| New Little window (search / URL box) | `⌥⇧N`, or click the toolbar icon |
| Open in Helium (move to a main window) | `⌘O` inside the page, `⌥⇧O` anywhere, or the floating bar |
| Copy the page link | `⌘⇧C` or the 🔗 button |
| Open a link in a Little window | `⌥`-click it, or right-click → **Open Link in Little Window** |
| Pop the current tab out | Right-click the page → **Pop Out Tab into Little Window** (or bind a shortcut) |
| Close | `⌘W`, `esc` on the start page, or the ✕ button |

Links opened from other apps (Mail, Slack, Messages…) are caught automatically and
moved into a Little window. Turn this off, or change the window size and position,
in the extension's options page.

To use Arc's exact `⌘⌥N`, rebind it at `helium://extensions/shortcuts`. Chromium
doesn't let an extension manifest ship `⌘⌥` combos as defaults, but you can set
them yourself there.

## How it works and its limits

An extension can't add native browser UI or intercept OS link handoffs, so the
extension approximates them:

- **Little window** = a Chromium `popup` window: no tab strip or toolbar, just a
  read-only address strip. The *Open in Helium* bar is injected into the page
  inside a closed shadow root.
- **Links from other apps** are spotted with a heuristic. A new tab that has an
  `http(s)` URL and no opener, created while Helium was in the background (or
  within 1.5 s of it coming to the front), is treated as external. Tabs restored
  at launch are ignored for the first 5 s. The trade-off is that a link that
  *launches* Helium from a cold start opens as a normal tab.
- **Promote** moves the tab into your most recently used main window. Chromium
  only moves tabs between normal windows, so when a move isn't allowed the URL is
  reopened. That reloads the page, so form input and scroll position are lost.
- `⌥`-click replaces Chromium's default "download this link" action on links.
  You can switch to `⇧`-click or `⌥⇧`-click, or turn it off, in options. Tabs
  that were already open when you installed the extension need a reload first.
- The floating bar can't appear on `helium://` pages, the extension store, or
  the PDF viewer, because extensions can't script those pages. The shortcuts
  still work there.

Debugging: open the service worker's console from `helium://extensions` and use
`littleHelium.openLittle('https://…')`, `littleHelium.state`, and so on.
