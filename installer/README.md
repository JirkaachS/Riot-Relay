# Riot Relay Setup (custom installer)

A small, separate Electron app whose only job is to present a fully custom
HTML/CSS install/uninstall wizard for Riot Relay, instead of NSIS's built-in
installer UI. It is built as a single **portable** exe (`target: portable`,
no admin rights, no elevation prompt) that unpacks the already-built app and
registers it with Windows like a normal per-user installer would.

This does **not** replace the existing NSIS/MSI builds — those keep being
built and published as before, and `electron-updater` in the main app still
silently drives the plain NSIS installer in the background for ongoing
updates. This wizard only replaces the *first-time download* experience, and
provides a matching custom uninstall flow (the same exe, run with
`--uninstall`).

## How it works

1. `npm run pack` (from the repo root) builds `dist/win-unpacked` — the
   already-built, signed Riot Relay app.
2. `build-payload.js` zips `dist/win-unpacked` into
   `installer/resources/payload.zip`, alongside a small `manifest.json`
   (app version + exe name) and a copy of the root `LICENSE`.
3. `electron-builder` (this folder's own config) packages `main.js` +
   `renderer/` + those resource files into one portable exe.
4. At install time, the wizard extracts `payload.zip` into
   `%LOCALAPPDATA%\Programs\Riot Relay`, copies itself in as
   `Uninstall Riot Relay.exe`, creates Desktop/Start Menu shortcuts via a
   `WScript.Shell` COM call, and writes a normal
   `HKCU\...\Uninstall\RiotRelay` registry entry so it shows up correctly in
   Windows' "Apps & Features".
5. Uninstalling reverses all of that, including a delayed self-delete of its
   own exe (via a short detached PowerShell) once the process has exited, so
   the running uninstaller exe never has to delete itself out from under
   itself.

All filesystem/registry/shortcut work is done with plain Node `fs` calls and
small PowerShell one-liners (`Expand-Archive`, `Compress-Archive`,
`WScript.Shell`, `New-Item`/`Set-ItemProperty` for the registry) — the same
pattern already used elsewhere in this project (`electron/switcher.js`,
`electron/league.js`) — so no new native dependency was introduced.

## Building locally

```powershell
# from the repo root
npm run pack                      # builds dist/win-unpacked
npm run installer:install-deps    # npm install inside installer/
npm run installer:build           # rebuilds the payload + the installer exe
```

The output exe is `installer/dist/Riot-Relay-Installer-<version>-x64.exe`.
It is named differently from `dist/Riot-Relay-Setup-<version>-x64.exe` (the
plain NSIS artifact) since both are uploaded to the same GitHub release and
asset names must be unique there.

## Testing

`test-setup-actions.js` exercises the real install/uninstall logic
(`setup-actions.js`) against a temporary directory and a small fake payload,
using the real Windows registry (a dedicated, self-cleaning HKCU key) and
real PowerShell shortcut/archive calls — without needing to click through
the wizard UI by hand:

```powershell
cd installer
node test-setup-actions.js
```

This is a standalone verification script, not part of the main project's
`npm test` suite (which only covers `electron/*.js`).
