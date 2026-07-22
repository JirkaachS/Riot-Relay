'use strict';

/**
 * build-payload.js — Packs the already-built app (dist/win-unpacked, from
 * the main project's `npm run pack`) into a single zip that this installer
 * ships as a resource and extracts at install time.
 *
 * Run order: from the repo root, `npm run pack` first (builds
 * dist/win-unpacked), then `npm --prefix installer run dist` (which calls
 * this script before invoking electron-builder for the installer itself).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const unpackedDir = path.join(repoRoot, 'dist', 'win-unpacked');
const resourcesDir = path.join(__dirname, 'resources');
const zipPath = path.join(resourcesDir, 'payload.zip');

if (!fs.existsSync(unpackedDir)) {
  console.error(`Payload source not found: ${unpackedDir}`);
  console.error('Run "npm run pack" from the repo root first to build dist/win-unpacked.');
  process.exit(1);
}

fs.mkdirSync(resourcesDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

// Compress-Archive is available on every Windows install (PowerShell 5.1+)
// and keeps this build free of any new zip dependency.
const script = `
$ErrorActionPreference = 'Stop'
Compress-Archive -Path (Join-Path '${unpackedDir.replace(/'/g, "''")}' '*') -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force
`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });

const version = require(path.join(repoRoot, 'package.json')).version;
fs.writeFileSync(
  path.join(resourcesDir, 'manifest.json'),
  JSON.stringify({ version, productName: 'Riot Relay', exeName: 'Riot Relay.exe' }, null, 2),
);
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(resourcesDir, 'LICENSE.txt'));

const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`PAYLOAD_OK ${zipPath} (${sizeMb} MB, v${version})`);
