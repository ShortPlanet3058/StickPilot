# StickPilot

Mirror and control a Fire TV (or any Android device with ADB debugging) from your computer.
It runs the [scrcpy](https://github.com/Genymobile/scrcpy) server on the device and shows the picture
in its own window with an on-screen remote. USB and Wi-Fi are both supported.

## Features

- **Screen + remote** or **Remote only** (no video, so no load on the device; compact window that can stay on top)
- Device screen with tabs per device type, USB and Wi-Fi grouped per physical device, one-click Wi-Fi setup and network discovery
- Remote with the keys Fire OS actually supports, keyboard control (typing works in text fields and in Amazon's letter-grid searches), Option/Alt shortcuts
- App launcher with favorites and force close
- Optional sound on the computer (off by default; warns and offers to turn it off if the picture starts lagging)
- Menu-bar mini remote; optional media keys
- Screenshots (full device resolution) and MP4 recording of the stream
- Drop an APK to install it, or any file to copy it to the device's Download folder
- Device panel: storage, memory, temperature, Wi-Fi signal, sleep / wake / restart

## Development

```bash
npm install
npm run vendor      # copies adb + scrcpy-server 4.1 from a local scrcpy download into vendor/
npm start           # builds and opens the app
```

- `npm run vendor -- /path/to/scrcpy-folder` picks another scrcpy download. Without vendor/, the app
  falls back to `STICKPILOT_SCRCPY_DIR` or `~/Documents/tools/scrcpy-macos-x86_64-v4.1`.
- `npm run typecheck` runs the TypeScript compiler.
- `npm run debug` prints the device-side server log.

### Driving the app from scripts

`npx electron . --remote-debugging-port=9223` starts the app with the DevTools protocol on.
`node scripts/cdp.mjs eval "<js>"` runs JavaScript in the window, `click <x> <y>` and `keys <key>...`
send real input, `drop <x> <y> <file>` simulates a file drop, and `shot out.png` saves a screenshot.
`CDP_PAGE=tray.html` targets the menu-bar remote. With `--inspect=9229`, `node scripts/main-eval.mjs "<js>"`
evaluates code in the main process (`STICKPILOT_DEBUG=1` also exposes `globalThis.__stickpilot`). `STICKPILOT_SCREENSHOT=out.png` saves one a few seconds after launch.

## Layout

| Path | What it does |
|---|---|
| `src/main/scrcpy.ts` | Client for scrcpy-server 4.1: video stream, remote keys, text, encoder detection |
| `src/main/devices.ts` | Live device list (`adb track-devices`), device identification, Wi-Fi connect |
| `src/main/profiles.ts` | Quality profiles; the software-encoder set was measured on a Fire TV Stick 4K Max |
| `src/main/recorder.ts` | MP4 recording of the incoming H.264 stream (no re-encoding) |
| `src/main/tray.ts` | Menu-bar icon, mini remote window, media keys |
| `src/main/typing.ts` | Sends typed text as text, or as letter key + OK on Amazon's letter-grid search screens |
| `src/main/main.ts` | Electron main process and IPC |
| `src/renderer/app.ts` | Device screen, player, device switcher, status screens |
| `src/renderer/remote.ts` | Remote layouts per device type (Fire TV, Android TV, phone) |
| `src/renderer/keyboard.ts` | Keyboard routing: keys go to the device while connected; shortcuts use Option/Alt |
| `src/renderer/video.ts` | H.264 decoding with WebCodecs |
| `src/renderer/audio.ts` | Opus decoding and low-latency playback |
| `src/renderer/apps.ts`, `devicePanel.ts`, `tray.ts` | App launcher, device panel, menu-bar remote |
| `tools/` | Benchmark and lag probe used to tune the profiles, plus the original shell script |

The server protocol changes between scrcpy versions, so the client is pinned to the bundled
server version (`SERVER_VERSION` in `src/main/paths.ts`).

## Licenses

scrcpy is Apache-2.0 (`vendor/scrcpy-LICENSE`). adb comes from Android SDK Platform-Tools; check its
terms before distributing builds.
