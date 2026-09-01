# Build resources

electron-builder reads this folder for the artwork and extra files that go into
an installer. It is committed empty on purpose — the app builds and runs without
any of it, using Electron's default icon.

To brand the builds, drop in:

| File | Used by | Size |
| --- | --- | --- |
| `icon.png` | all three platforms | 1024×1024 (512×512 minimum) |
| `icon.icns` | macOS, if you'd rather not let electron-builder convert | — |
| `icon.ico` | Windows, same | 256×256 and down |
| `background.png` | the macOS DMG window | 540×380 (@2x: `background@2x.png`) |

A single `icon.png` is enough: electron-builder derives the macOS and Windows
formats from it. Nothing here is referenced by name from the app itself, so
adding files is all that is needed.
