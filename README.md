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
| Hide the floating bar | Its ✕ button (for that Little window; `⌘O` still works) |
| Close | `⌘W`, or `esc` on the start page |

Links opened from other apps (Mail, Slack, Messages…) are caught automatically and
moved into a Little window. Turn this off, or change the window size and position,
in the extension's options page. Little windows cover two-thirds of the
screen's area by default.

To use Arc's exact `⌘⌥N`, rebind it at `helium://extensions/shortcuts`. Chromium
doesn't let an extension manifest ship `⌘⌥` combos as defaults, but you can set
them yourself there.

## How it works and its limits

An extension can't add native browser UI or intercept OS link handoffs, so the
extension approximates them:

- **Little window** = a Chromium `popup` window: no tab strip or toolbar, just a
  read-only address strip. The *Open in Helium* bar is injected into the page
  inside a closed shadow root.
- **Links from other apps** (Raycast quicklinks, Mail, Slack, `open <url>`…)
  are recognized by how Chromium labels them. A link handed over by the OS
  commits with the `start_page` transition, which ordinary browsing never
  produces. Startup pages share that label, so the first 5 s after launch are
  ignored. As a result, a link that *launches* Helium from closed opens as a
  normal tab.
- **Full screen:** while its active window is full screen, Helium opens every
  new window full screen too. Little Helium works around this by creating the
  Little window minimized and then restoring it, which lets it float over the
  full-screen window like Little Arc (about a second of animation). This also
  applies when a link from another app pulls you onto Helium's full-screen
  Space.
- **Other apps' full-screen Spaces:** a Little window can't appear over
  another app's full-screen Space (Claude, Zen, …). When Helium comes forward,
  macOS switches you to a Space with Helium's windows, and macOS won't place a
  Helium window on another app's full-screen Space. Arc gets around this with a
  native window setting that extensions can't apply to Helium's windows.
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
