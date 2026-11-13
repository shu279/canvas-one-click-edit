# Canvas One Click Edit

Edit Obsidian Canvas text and Markdown cards with **a single click**, and pan or zoom the Canvas while your pointer is over a selected card.

- Click once to start typing or switch between cards.
- Drag cards and use modifier keys to select them as usual.
- Scroll vertically inside cards; scroll horizontally to pan the Canvas.
- Pinch to zoom using Canvas's native controls.

Desktop only. Confirmed working on Mac; Windows and Linux are unverified. No API key or external service is required.

## Install

1. Download this repository via **Code → Download ZIP** and extract it.
2. Create `.obsidian/plugins/canvas-one-click-edit/` inside your vault. On Mac, press `Command + Shift + .` in Finder to show hidden folders.
3. Copy `main.js` and `manifest.json` into that folder.
4. Restart Obsidian and enable **Canvas One Click Edit** under **Settings → Community plugins**.

No build step is needed. When updating, replace those two files and keep your existing `data.json`.

## Settings

Under **Settings → Canvas One Click Edit**, you can toggle one-click editing, choose card types, and adjust cursor placement.

**Canvas navigation over selected cards** controls horizontal panning and zooming over cards independently. Turn it off if you need to scroll sideways inside a wide table or code block. If cursor placement feels inaccurate, turn off **Place cursor near click**.

## Notes

One-click editing supports text and Markdown cards, not PDFs, images, web cards, or groups. It does not start editing when multiple cards are selected.

This plugin uses internal Canvas APIs, so Obsidian updates or other plugins may affect it. Disabling it restores standard behavior.

For problems, [open an issue](https://github.com/shu279/canvas-one-click-edit/issues) with your Obsidian version and steps to reproduce. The command palette includes **Show last Canvas click diagnostics** and **Show last Canvas scroll diagnostics** to help troubleshoot.

[MIT License](LICENSE) · Maintained by Shu
