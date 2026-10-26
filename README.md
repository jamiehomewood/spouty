# Spouty

Replaces OBS + Browser source + Spout plugin. It loads the scene page offscreen at a fixed size
and sends every frame out over Spout, so IglooPreview (or the room) can pick it up.

## Use

1. Start the scene server as usual (`start-server.bat`).
2. Run `Spouty.exe`. It starts sending straight away as **spoutyfeed**.
3. In IglooPreview, select the `spoutyfeed` sender.

Close the small window to stop.

## The window

| OBS / plugin setting | Here |
|---|---|
| Browser source URL | **Page URL** (default `http://localhost:8000/stage.html`), then **Load** or Enter |
| Browser source size | **Width / Height** (default 4096 x 2048) |
| Spout sender name | **Spout sender name** (default `spoutyfeed`) |
| Spout AutoStart | Always on |
| Control audio via OBS | **Audio output** - pick the speakers; **Mute** |
| Right-click > Interact, then keys | Buttons, or press Space / Y / N / R / T / S / H with this window in front |
| Refresh cache of current page | **Load** (with the URL unchanged, it reloads the page) |

Settings save to `config.json` next to the exe. You can also pass them on the command line, e.g.
`Spouty.exe --url=http://localhost:8000/index.html?hud=1 --senderName=Test`
(command-line values apply to that run only).

The box turns orange while a typed URL hasn't been loaded yet. **Showing:** under it is the page actually being sent.
You can leave out `http://` (`localhost:8000/index.html` works). Editing `config.json` while Spouty is running
also takes effect within a second.

If the scene server isn't running yet, it keeps retrying every 3 seconds.
Still pages are re-sent a few times a second, so a receiver always has the current image.

## Frame rate

The default sends frames through system memory (like OBS does). If the fps readout is low at 4096 x 2048,
tick **Advanced > GPU zero-copy mode**, which hands the GPU texture straight to Spout.

## Building

Needs Node.js. `npm install`, then `npm start` to run, or `npm run package` to make the Windows build
in `dist/`. Copy `msvcp140.dll`, `vcruntime140.dll` and `vcruntime140_1.dll` next to the exe
(or install the Microsoft Visual C++ 2015-2022 x64 runtime).

Spout comes from `native/electron-spout.node`, a prebuilt copy of
[electron-spout](https://github.com/fusefactory/electron-spout) (MIT) for Electron 38.8.0 x64,
built on [Spout2](https://spout.zeal.co/) (BSD). If you change the Electron version, rebuild that addon from source.
