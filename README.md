# Riot Relay

Riot Relay is a Windows account command center for Riot games: encrypted credentials, identity-bound sessions, deliberate account switching, unified account data, inventory tools, current-session chat, and privacy-first presence controls.

**Version 1.3.0** · [Documentation](https://jirkaachs.github.io/Riot-Relay/) · [Latest release](https://github.com/JirkaachS/Riot-Relay/releases/latest) · [Security](https://jirkaachs.github.io/Riot-Relay/security.html) · [Privacy](https://jirkaachs.github.io/Riot-Relay/privacy.html)

## What it protects

- Account passwords are stored in a local AES-256-GCM encrypted vault protected by a master-password-derived key.
- Optional Windows-protected stored-key modes are configured per vault and disabled by default.
- Riot PUUID is the authoritative identity binding. Sync/capture flows verify the active identity before sessions, ranks, inventory, portraits, or metadata are attached to a roster entry.
- A mismatched identity should be rejected rather than silently associated with another account.

Encryption at rest does not protect an unlocked vault or active Riot session from malware or someone controlling the same Windows account. Keep Riot multi-factor authentication enabled and use a unique master password; there is no hosted password recovery.

## Install

Open the [latest GitHub Release](https://github.com/JirkaachS/Riot-Relay/releases/latest), expand **Assets**, and download a Windows x64 installer rather than a source archive:

- **EXE / NSIS (recommended):** normal installation and the preferred path for automatic application updates.
- **MSI:** administrator-managed deployment or manual updates.

Riot Relay does **not** claim code signing. Windows SmartScreen may show an unsigned/unrecognized-app warning. Download only from `JirkaachS/Riot-Relay` releases, inspect the tag/source and published checksums when available, and proceed only if you trust the build.

## Development and builds

```powershell
npm ci
npm test
npm start
```

Tagged releases are designed to run tests and invoke `npm run release:nsis` and `npm run release:msi` for Windows x64 publishing. Those scripts are the repository’s release-build interface; a checkout must define them before its release workflow can succeed. The workflow uses the tag-triggered GitHub token and does not imply code signing.

## Updates and network behavior

An update-enabled EXE build may contact GitHub Releases to compare versions and download an update. GitHub receives ordinary connection metadata; account credentials are not required for update checks. MSI deployments are updated by the administrator or user. Requested Riot, rank, inventory, catalog, chat, profile, and presence features communicate with Riot or identified third-party services as described in the [privacy disclosure](https://jirkaachs.github.io/Riot-Relay/privacy.html).

## Support and responsible reporting

Start with the [troubleshooting guide](https://jirkaachs.github.io/Riot-Relay/troubleshooting.html). Use GitHub’s private vulnerability reporting feature when available; otherwise request a private maintainer contact in a minimal issue. Never post credentials, tokens, vault/session files, private logs, or real account identifiers.

## Project status and attribution

Riot Relay is unofficial community software and is not endorsed by Riot Games. Riot Games and associated properties are trademarks or registered trademarks of Riot Games, Inc.

The built-in presence proxy is informed by [Deceive](https://github.com/molenzwiebel/Deceive). OP.GG protocol research was informed by [OPGG.py](https://github.com/ShoobyDoo/OPGG.py); its source and Python runtime are not bundled. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for complete attribution.

Licensed under the [MIT License](LICENSE).