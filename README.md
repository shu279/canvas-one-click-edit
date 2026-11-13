# Canvas One Click Edit

A desktop plugin for Obsidian that lets you **edit Canvas text cards and Markdown note cards with a single click**.

- Click a card once and start typing. Switch directly to another card with one click.
- Pan and zoom the Canvas while your pointer is over a selected card or a card you are editing.
- Keep vertical scrolling inside cards, drag-to-move, and selection with modifier keys.
- Enable or disable one-click editing and Canvas navigation independently.

**Version: 0.6.0 / Experimental.** Confirmed working in the maintainer's **Mac environment**. The exact macOS and Obsidian versions used for that confirmation were not recorded. Windows and Linux are unverified, and compatibility with other Canvas plugins and themes has not been comprehensively tested.

The manifest requires Obsidian **1.8.0 or newer**. Operation on that minimum version has not been verified. No API key or external service is required.

[Changelog (Japanese)](CHANGELOG.md)

## Installation on Mac

1. Download this repository using **Code → Download ZIP** on GitHub, then extract it.
2. Create `.obsidian/plugins/canvas-one-click-edit/` inside your vault. In Finder, press `Command + Shift + .` to show hidden folders.
3. Copy **only `main.js` and `manifest.json`** from the extracted repository into that folder. The plugin loads JavaScript directly, so no build step or Node.js installation is needed.
4. Restart Obsidian.
5. Enable **Settings → Community plugins → Canvas One Click Edit**.

Use the same two files if you download from a GitHub Release.

## Upgrading

1. Turn **Settings → Community plugins → Canvas One Click Edit** OFF.
2. Replace **only `main.js` and `manifest.json`** in the existing `.obsidian/plugins/canvas-one-click-edit/` folder with the files from the ZIP. Keep your existing `data.json` and other plugins.
3. Quit Obsidian normally, then reopen it.
4. Enable the plugin and confirm that its version is **0.6.0**.

## Scrolling and zooming over selected cards (0.6.0)

Keep a card selected or in edit mode, and place your pointer over its content.

| Gesture | Behavior |
| --- | --- |
| Vertical scroll | Scrolls vertically within the card as usual |
| Horizontal scroll | Pans the entire Canvas horizontally, rather than scrolling the card's content sideways |
| Pinch, Ctrl/Cmd + wheel, and similar zoom gestures | Passes the gesture to Canvas's native zoom handling |
| Shift + vertical wheel | Pans the entire Canvas horizontally |

Diagonal gestures pan the Canvas only when the horizontal component is larger than the vertical component. In that case, the Canvas moves horizontally only. If the vertical component is equal or larger, the plugin leaves the gesture alone, so small sideways movements during vertical scrolling do not move the Canvas.

Zoom direction, speed, and center follow Canvas's native behavior. If you change Canvas's default mouse-wheel behavior, modifiers such as Ctrl/Cmd retain their native meaning. Gestures over unselected cards and the Canvas background are unchanged. Navigation over selected cards also works when the Canvas is locked against editing.

Toggle this feature under **Settings → Canvas One Click Edit → Canvas navigation over selected cards**. It is ON by default. Turn it OFF when you want to scroll horizontally **inside** wide tables or code blocks. This setting is independent of one-click editing.

For text and Markdown cards in edit mode, gestures inside Obsidian's editor iframe are also handled. The plugin does not intercept gestures inside external web pages or PDF viewer iframes embedded in notes.

### Checking navigation and diagnostics

1. Select or edit a card containing a long passage.
2. Place your pointer over the card's content and try vertical scrolling, horizontal scrolling, and pinching.
3. If a gesture does not work, immediately press `Command + P` and run **Show last Canvas scroll diagnostics**.

`Horizontal pan → Canvas` and `Native zoom gesture → Canvas` identify gestures the plugin handled. `source=editor iframe` means the gesture came from the editor; `source=card` means it came from the card's normal content area. `Bound Canvas views` and `editor frames` count the views and frames being monitored. Vertical scrolling intentionally does not update this diagnostic log because the plugin does not intervene.

Navigation monitoring continues while the Canvas and editor are open; it does not stop eight seconds after editing begins. Listeners are reattached when the editor is recreated and removed when the plugin is disabled.

## One-click editing

- **Click a card once** to enter edit mode and start typing.
- **While editing card A, click card B once** to switch directly to editing B.
- **Drag a card** to move it as usual.
- Click with `Shift`, `Command`, `Option`, or `Control` to use normal selection behavior.
- Editing does not start automatically when multiple cards are selected.
- One-click editing does not apply to PDFs, images, web cards, or groups.
- Configure supported card types and cursor placement under **Settings → Canvas One Click Edit**.

## Checking editing and diagnostics

Start with a copy of a Canvas for testing.

1. Begin editing card A.
2. Click the content of card B **just once**.
3. Type a single lowercase `a`. Do not click B again; wait one or two seconds.
4. Press `Command + P`, find **Show last Canvas click diagnostics**, and run it.

The diagnostic notice stays visible for 20 seconds. It begins with **Canvas One Click Edit 0.6.0** and your Obsidian version.

- `source / editing / ready / writable`: The event source and whether B is in edit mode, its editor is ready, and it is writable. For state values, `1` means true, `0` means false, and `?` means unknown.
- `Focus samples`: Whether B had focus at each sampled moment after the click. An initial `1` alone is not treated as success.
- `Keys in B`: The number of typing-related key events received by B's editor.
- `elsewhere`: The number of typing-related key events received outside B.
- `Beforeinput / input`: The number of browser input events received by B.
- `B document changed`: Whether B's CodeMirror document changed around those input events. Also check whether the character actually appeared on screen.
- `Vim-normal`: Whether Vim normal mode was detected. The plugin does not change your Vim settings or mode.

The older `Editor focus VERIFIED` message only confirmed focus at a single moment. This version records sustained focus and actual input events separately. `Focus held >=300ms` alone does not prove that typing succeeded.

Click diagnostics monitor input events for up to eight seconds after a click. Monitoring ends on a new click, a shortcut, or plugin deactivation. This is separate from scroll monitoring. Note content, typed characters, and filenames are neither logged nor sent to an external service.

## Limitations

This plugin uses Canvas internals such as `node.startEditing()`, `child.editMode`, and `canvas.onWheel()`, rather than a stable public API. Future Obsidian updates or other plugins may affect its behavior. The implementation was informed by inspecting Obsidian 1.15.0's internal behavior. It is confirmed working in the maintainer's Mac environment, but results for specific combinations with other plugins, such as Advanced Canvas, have not been recorded. This repository does not include an automated test suite, so verify interactions in Obsidian after making changes.

Placing the cursor near the click is best-effort. When a card's preview and editor layouts differ, the cursor may not land at the exact character you clicked. If this causes problems, turn **Place cursor near click** OFF.

Disabling the plugin restores standard click behavior. The plugin does not directly rewrite `.canvas` files or note content. Edits you type are saved through Obsidian's normal saving behavior.

## Reporting problems

Open a GitHub issue with your OS, Obsidian, and plugin versions, steps to reproduce the problem, and any other Canvas plugins you use. Include **Show last Canvas click diagnostics** for click problems or **Show last Canvas scroll diagnostics** for scrolling problems. Do not attach private note content or `data.json`.

## Development

`main.js` is both the source code and the distributed plugin file. Run `node --check main.js` to check its syntax. See [RELEASING.md](RELEASING.md) for release files and instructions.

## License

[MIT License](LICENSE). Maintained by Shu.
