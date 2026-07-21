'use strict';

/**
 * switcher.js — Seamless account switching on Windows.
 *
 * Flow:
 *   1. Terminate every Riot/VALORANT/League process (so a fresh login is forced).
 *   2. Relaunch RiotClientServices.exe pointed at VALORANT.
 *   3. Wait for the login window, then auto-fill the stored username + password
 *      via the Windows UI automation shim (SendKeys) and submit.
 *
 * The auto-fill step uses PowerShell + System.Windows.Forms.SendKeys, which is
 * the reliable, dependency-free method on Windows. Credentials are passed to the
 * script over stdin (never on the command line / never written to disk).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const RIOT_PROCESSES = [
  'RiotClientServices', 'RiotClientUx', 'RiotClientUxRender', 'RiotClientCrashHandler',
  // Riot's newer Chromium shell runs as "Riot Client.exe". If it survives,
  // the relaunch only signals that stale process and it keeps its in-memory
  // signed-out state instead of loading the restored session file.
  'Riot Client', 'RiotClientElectron',
  'VALORANT', 'VALORANT-Win64-Shipping',
  'LeagueClient', 'LeagueClientUx', 'LeagueClientUxRender', 'League of Legends',
  'LoR', 'LegendsOfRuneterra',
];

const DEFAULT_CLIENT_PATHS = [
  'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
  'C:\\Program Files\\Riot Games\\Riot Client\\RiotClientServices.exe',
  'C:\\Program Files (x86)\\Riot Games\\Riot Client\\RiotClientServices.exe',
];

// All Riot titles launch through RiotClientServices with a product/patchline.
// Deceive accepts lol | lor | valorant (TFT rides the League client).
const GAMES = {
  valorant: {
    label: 'VALORANT', product: 'valorant', patchline: 'live', deceive: 'valorant',
    processes: ['VALORANT', 'VALORANT-Win64-Shipping'],
  },
  lol: {
    label: 'League of Legends', product: 'league_of_legends', patchline: 'live', deceive: 'lol',
    processes: ['LeagueClient', 'LeagueClientUx', 'League of Legends'],
  },
  tft: {
    label: 'Teamfight Tactics', product: 'league_of_legends', patchline: 'live', deceive: 'lol',
    processes: ['LeagueClient', 'LeagueClientUx', 'League of Legends'],
  },
  lor: {
    label: 'Legends of Runeterra', product: 'bacon', patchline: 'live', deceive: 'lor',
    processes: ['LoR', 'LegendsOfRuneterra'],
  },
};

function findRiotClient(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  for (const p of DEFAULT_CLIENT_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

// The Riot Client persists your login (the "stay signed in" session cookie) in
// these files. If we don't clear them, relaunching just resumes the current
// account instead of switching. Removing them forces the login screen.
const RIOT_DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Data');
const LOL_DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'League of Legends', 'Data');
// Only the login/session cookie — do NOT touch RiotClientPrivateSettings.yaml
// (client/UI prefs); removing that makes the client reinitialise and relaunch.
const SESSION_FILE = 'RiotGamesPrivateSettings.yaml';

function clearRiotSession() {
  let removed = 0;
  let removalFailed = false;
  for (const dir of [RIOT_DATA_DIR, LOL_DATA_DIR]) {
    const file = path.join(dir, SESSION_FILE);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      removalFailed = true;
    }
    // Never launch with ambiguous auth state. A locked file means a Riot
    // process survived and could override the account selected by the caller.
    if (fs.existsSync(file)) removalFailed = true;
  }
  if (removalFailed) {
    throw new Error('Riot session data was still locked, so the account switch was stopped safely. Close Riot Client and retry.');
  }
  return removed;
}

function ps(script, stdin = null, onLine = null, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      windowsHide: true,
    });
    let out = '', err = '', pending = '', settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already stopped */ }
      finish(reject, new Error('Native Windows helper timed out.'));
    }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (data) => {
      const text = String(data);
      out += text;
      if (!onLine) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line.trim()) {
        try { onLine(line.trim()); } catch { /* diagnostics only */ }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => finish(reject, new Error(safeError(error, 'Native Windows helper failed.'))));
    child.on('close', (code) => {
      if (onLine && pending.trim()) {
        try { onLine(pending.trim()); } catch { /* diagnostics only */ }
      }
      if (code === 0) return finish(resolve, out.trim());
      const rawReason = err.trim().split(/\r?\n/)[0] || `PowerShell exited ${code}`;
      finish(reject, new Error(safeError(rawReason, 'Native login helper failed.')));
    });
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeError(error, fallback = 'Operation failed.') {
  let message = String(error && error.message ? error.message : error || fallback);
  message = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|access[_-]?token|refresh[_-]?token|token|password|secret)\b["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[redacted-path]')
    .replace(/\\\\[^\\\s]+\\[^\r\n"'<>]*/g, '[redacted-path]')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[redacted-id]')
    .replace(/\b(puuid|uuid|accountId|processId|pid)\b["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[redacted-id]')
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, '[redacted-id]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return message.slice(0, 180);
}

function safeProgressLabel(label) {
  return safeError(label, 'Switch in progress.')
    .replace(/\b(?:pid|processId|class|windowClass|size)\s*=\s*[^\s,;]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 180) || 'Switch in progress.';
}

async function killRiotProcesses() {
  const names = RIOT_PROCESSES.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const script = `
    $names = @(${names})
    foreach ($n in $names) {
      Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    # Wait until every Riot process is actually gone (up to ~10s) so a relaunch
    # doesn't race a still-terminating client (which causes the login window to
    # close and reopen).
    for ($i = 0; $i -lt 50; $i++) {
      $alive = $false
      foreach ($n in $names) { if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $alive = $true; break } }
      if (-not $alive) { break }
      Start-Sleep -Milliseconds 200
    }
    if ($alive) { exit 23 }
    'ok'
  `;
  try { await ps(script); }
  catch { throw new Error('Riot or game processes were still running, so the switch was stopped before changing session or configuration.'); }
}

/**
 * Launch VALORANT. When Deceive is enabled and present, we start it instead of
 * the Riot Client directly — Deceive spawns the client for us while spoofing the
 * chat connection so you appear offline. Usage: `Deceive.exe valorant`.
 */
/**
 * Launch the chosen Riot game through RiotClientServices. When `configUrl` is
 * provided (our built-in Deceive proxy), the client is pointed at it so its
 * chat connection is routed through us for "appear offline".
 */
function launchClient(clientPath, { game = null, configUrl = '' } = {}) {
  // The default switch authenticates the Riot Client only. A product is added
  // solely for the explicit “Switch + launch game” action.
  const args = [];
  const selected = game && GAMES[game];
  if (selected) args.push(`--launch-product=${selected.product}`, `--launch-patchline=${selected.patchline}`);
  if (configUrl) args.unshift(`--client-config-url=${configUrl}`);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      child = spawn(clientPath, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      reject(new Error(safeError(error, 'Riot Client launch request failed.')));
      return;
    }
    child.once('error', (error) => finish(reject, new Error(safeError(error, 'Riot Client launch request failed.'))));
    child.once('spawn', () => {
      child.unref();
      finish(resolve, { launcherAccepted: true, productRequested: Boolean(selected) });
    });
  });
}

async function waitForProductStart(game, { timeoutMs = 45000, sinceEpochMs = 0 } = {}) {
  const selected = game && GAMES[game];
  if (!selected || !Array.isArray(selected.processes) || !selected.processes.length) {
    return { launchVerified: false, game };
  }
  const boundedTimeoutMs = Math.min(60000, Math.max(2000, Number(timeoutMs) || 45000));
  const names = selected.processes.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const iterations = Math.max(1, Math.ceil(boundedTimeoutMs / 1000));
  // Only count a process that actually STARTED after our launch mark. A stale
  // VALORANT/League process (or a lingering crash/Vanguard-adjacent process)
  // must never be mistaken for a fresh launch — that produced false positives.
  const since = Math.max(0, Number(sinceEpochMs) || 0);
  const script = `
    $names = @(${names})
    $since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime
    for ($i = 0; $i -lt ${iterations}; $i++) {
      foreach ($name in $names) {
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
          try { if ($p.StartTime -ge $since) { 'ready'; exit 0 } } catch { }
        }
      }
      Start-Sleep -Milliseconds 1000
    }
    exit 24
  `;
  try {
    const result = await ps(script, null, null, boundedTimeoutMs + 5000);
    if (result.trim() === 'ready') return { launchVerified: true, game };
  } catch { /* Best-effort detection only; see launchProduct. */ }
  // Not observing a freshly started game process is NOT a hard failure:
  // RiotClientServices with --launch-product opens the client on that game, but
  // the game process itself may only appear after patching or once the user
  // presses PLAY. Upstream Deceive never verifies the game process at all.
  return { launchVerified: false, game };
}

async function launchProduct(clientPath, { game, configUrl = '' } = {}) {
  const selected = game && GAMES[game];
  if (!selected) throw new Error('The requested Riot product is not supported.');
  // Launch exactly once, like upstream Deceive. Re-spawning RiotClientServices
  // while the previous instance is still initializing makes the second call
  // merely signal the first (which may be ignored), so we do not double-launch.
  const launchMark = Date.now();
  await launchClient(clientPath, { game, configUrl });
  const detection = await waitForProductStart(game, { timeoutMs: 25000, sinceEpochMs: launchMark });
  // launcherAccepted: RiotClientServices accepted the request (the game is
  // launching/patching or waiting on PLAY). launchVerified: a freshly started
  // game process was actually observed. The switch succeeds on acceptance.
  return {
    launchRequested: true,
    launcherAccepted: true,
    launchVerified: detection.launchVerified === true,
    game,
  };
}

/**
 * Wait until the Riot Client login window exists, then type credentials.
 * The SendKeys automation focuses the window, fills the username field,
 * tabs to the password field, fills it, and presses Enter.
 */
async function autoLogin(username, password, clientPath, onDiagnostic = () => {}) {
  const stdin = JSON.stringify({ u: username, p: password, r: path.dirname(clientPath) });

  // Riot's Chromium controls are not reliably exposed through UI Automation.
  // Select the largest visible RiotClientUx window, explicitly click each field,
  // and use native Unicode SendInput rather than assuming autofocus/Tab order.
  const script = `
    $raw = [Console]::In.ReadToEnd()
    $creds = $raw | ConvertFrom-Json
    Write-Output '{"checkpoint":"HELPER_STARTED"}'

    Add-Type -TypeDefinition @"
      using System;
      using System.Collections.Generic;
      using System.Runtime.InteropServices;
      using System.Text;
      using System.Threading;

      public static class NativeInput {
        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const int SW_RESTORE = 9;
        private const uint GW_OWNER = 4;

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
          [FieldOffset(0)] public MOUSEINPUT mi;
          [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
          public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
          public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo;
        }

        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll", SetLastError=true)] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

        public static IntPtr FindRiotWindow(uint[] processIds) {
          HashSet<uint> wanted = new HashSet<uint>(processIds ?? new uint[0]);
          IntPtr best = IntPtr.Zero; long bestScore = 0;
          EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            RECT r; if (!wanted.Contains(pid) || !IsWindowVisible(h) || GetWindow(h, GW_OWNER) != IntPtr.Zero || !GetWindowRect(h, out r)) return true;
            long width = r.Right - r.Left, height = r.Bottom - r.Top;
            if (width < 700 || height < 400) return true;
            string cls = ClassName(h);
            long score = width * height + (cls.StartsWith("Chrome_WidgetWin") ? 1000000000L : 0L);
            if (score > bestScore) { best = h; bestScore = score; }
            return true;
          }, IntPtr.Zero);
          return best;
        }

        public static string ClassName(IntPtr h) {
          StringBuilder b = new StringBuilder(256); GetClassName(h, b, b.Capacity); return b.ToString();
        }
        public static uint ProcessId(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
        public static int ClientWidth(IntPtr h) { RECT r; return GetClientRect(h, out r) ? r.Right - r.Left : 0; }
        public static int ClientHeight(IntPtr h) { RECT r; return GetClientRect(h, out r) ? r.Bottom - r.Top : 0; }

        public static bool Activate(IntPtr h) {
          for (int attempt = 0; attempt < 8; attempt++) {
            ShowWindow(h, SW_RESTORE);
            IntPtr foreground = GetForegroundWindow();
            uint unused, fgThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out unused);
            uint targetThread = GetWindowThreadProcessId(h, out unused);
            uint currentThread = GetCurrentThreadId();
            bool attachedFg = fgThread != 0 && AttachThreadInput(currentThread, fgThread, true);
            bool attachedTarget = targetThread != 0 && AttachThreadInput(currentThread, targetThread, true);
            BringWindowToTop(h); SetForegroundWindow(h);
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedFg) AttachThreadInput(currentThread, fgThread, false);
            Thread.Sleep(120);
            if (GetForegroundWindow() == h) return true;
          }
          return false;
        }

        private static INPUT Key(ushort vk, ushort scan, uint flags) {
          INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
          i.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
          return i;
        }
        public static int SelectAll() {
          INPUT[] keys = { Key(0x11, 0, 0), Key(0x41, 0, 0), Key(0x41, 0, KEYEVENTF_KEYUP), Key(0x11, 0, KEYEVENTF_KEYUP) };
          return (int)SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(INPUT)));
        }
        public static int SendUnicode(string text) {
          List<INPUT> keys = new List<INPUT>();
          foreach (char c in text ?? "") { keys.Add(Key(0, c, KEYEVENTF_UNICODE)); keys.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); }
          if (keys.Count == 0) return 0;
          INPUT[] input = keys.ToArray();
          return (int)SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(INPUT)));
        }
        public static int Enter() {
          INPUT[] keys = { Key(0x0D, 0, 0), Key(0x0D, 0, KEYEVENTF_KEYUP) };
          return (int)SendInput(2, keys, Marshal.SizeOf(typeof(INPUT)));
        }
        public static int ClickClient(IntPtr h, double xRatio, double yRatio) {
          RECT r; if (!GetClientRect(h, out r)) return 0;
          POINT p = new POINT { X = (int)Math.Round((r.Right - r.Left) * xRatio), Y = (int)Math.Round((r.Bottom - r.Top) * yRatio) };
          if (!ClientToScreen(h, ref p) || !SetCursorPos(p.X, p.Y)) return 0;
          INPUT down = new INPUT(); down.type = INPUT_MOUSE; down.U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
          INPUT up = new INPUT(); up.type = INPUT_MOUSE; up.U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
          INPUT[] clicks = { down, up };
          return (int)SendInput(2, clicks, Marshal.SizeOf(typeof(INPUT)));
        }
      }
"@

    [NativeInput]::SetProcessDPIAware() | Out-Null
    function Get-TrustedRiotPids {
      $root = [IO.Path]::GetFullPath([string]$creds.r).TrimEnd([char]92) + [char]92
      [uint32[]]@(
        Get-CimInstance Win32_Process -Filter "Name = 'RiotClientUx.exe' OR Name = 'Riot Client.exe'" -ErrorAction SilentlyContinue |
          Where-Object {
            $name = ([string]$_.Name).ToLowerInvariant()
            $exe = [string]$_.ExecutablePath
            $allowedName = $name -eq 'riotclientux.exe' -or $name -eq 'riot client.exe'
            $allowedName -and $exe -and $exe.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
          } |
          ForEach-Object { [uint32]$_.ProcessId }
      )
    }

    function Test-LoginControls([IntPtr]$handle) {
      try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if ($null -eq $root) { return $false }
        $condition = [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Edit
        )
        $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        return $null -ne $edits -and $edits.Count -ge 2
      } catch { return $false }
    }

    function Assert-TrustedRiotWindow([IntPtr]$handle) {
      [uint32[]]$trustedProcessIds = @(Get-TrustedRiotPids)
      $windowProcessId = [NativeInput]::ProcessId($handle)
      if ($handle -eq [IntPtr]::Zero -or -not ($trustedProcessIds -contains $windowProcessId)) {
        throw 'LOGIN_WINDOW_CHANGED: the trusted Riot login window closed or was replaced'
      }
    }

    $h = [IntPtr]::Zero
    $stable = 0; $lastHandle = [IntPtr]::Zero; $lastWidth = 0; $lastHeight = 0
    $trustedObservedSince = $null; $windowDetected = $false
    for ($i = 0; $i -lt 80; $i++) {
      # Only accept Riot Chromium executables beneath the same installation
      # root as RiotClientServices. This excludes Riot Relay and unrelated
      # windows whose process names merely begin with "Riot".
      [uint32[]]$pids = @(Get-TrustedRiotPids)
      $candidate = [NativeInput]::FindRiotWindow($pids)
      if ($candidate -ne [IntPtr]::Zero) {
        $width = [NativeInput]::ClientWidth($candidate); $height = [NativeInput]::ClientHeight($candidate)
        if (-not $windowDetected) {
          Write-Output '{"checkpoint":"WINDOW_DETECTED"}'
          $windowDetected = $true
        }
        if ($candidate -eq $lastHandle -and $width -eq $lastWidth -and $height -eq $lastHeight) {
          $stable++
        } else {
          $stable = 0
          $trustedObservedSince = [DateTime]::UtcNow
        }
        $lastHandle = $candidate; $lastWidth = $width; $lastHeight = $height
        if ($stable -ge 4) { $h = $candidate; break }
      } else {
        $stable = 0; $lastHandle = [IntPtr]::Zero; $lastWidth = 0; $lastHeight = 0
        $trustedObservedSince = $null
      }
      Start-Sleep -Milliseconds 500
    }
    if ($h -eq [IntPtr]::Zero) { throw 'WINDOW_NOT_FOUND: no stable trusted Riot login window appeared' }
    [pscustomobject]@{
      checkpoint = 'WINDOW_SELECTED'
      processId = [NativeInput]::ProcessId($h)
      windowClass = [NativeInput]::ClassName($h)
      width = [NativeInput]::ClientWidth($h)
      height = [NativeInput]::ClientHeight($h)
    } | ConvertTo-Json -Compress | Write-Output

    # A top-level Chromium HWND appears before its form. Prefer the actual UIA
    # edit-control signal when Riot exposes it; otherwise require eight seconds
    # of continuous stability from the first trusted observation. Keeping that
    # timestamp avoids restarting the hydration wait after window selection.
    $formReady = $false; $readyStable = $stable
    if ($null -eq $trustedObservedSince) { $trustedObservedSince = [DateTime]::UtcNow }
    for ($i = 0; $i -lt 60; $i++) {
      [uint32[]]$readyPids = @(Get-TrustedRiotPids)
      $candidate = [NativeInput]::FindRiotWindow($readyPids)
      if ($candidate -ne [IntPtr]::Zero) {
        $width = [NativeInput]::ClientWidth($candidate); $height = [NativeInput]::ClientHeight($candidate)
        if ($candidate -eq $lastHandle -and $width -eq $lastWidth -and $height -eq $lastHeight) {
          $readyStable++
        } else {
          $readyStable = 0
          $trustedObservedSince = [DateTime]::UtcNow
        }
        $lastHandle = $candidate; $lastWidth = $width; $lastHeight = $height
        $elapsed = ([DateTime]::UtcNow - $trustedObservedSince).TotalMilliseconds
        if ((Test-LoginControls $candidate) -or ($elapsed -ge 8000 -and $readyStable -ge 8)) {
          $h = $candidate; $formReady = $true; break
        }
      } else {
        $readyStable = 0; $lastHandle = [IntPtr]::Zero; $lastWidth = 0; $lastHeight = 0
        $trustedObservedSince = $null
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not $formReady) { throw 'FORM_NOT_READY: Riot opened a window but its login form did not become ready' }
    Assert-TrustedRiotWindow $h
    Write-Output '{"checkpoint":"FORM_SETTLE_WAIT_COMPLETE"}'

    Assert-TrustedRiotWindow $h
    if (-not [NativeInput]::Activate($h)) { throw 'FOREGROUND_DENIED: Windows would not give focus to the ready Riot login window' }
    Write-Output '{"checkpoint":"FOREGROUND_ACQUIRED"}'

    Assert-TrustedRiotWindow $h
    if ([NativeInput]::ClickClient($h, 0.13, 0.295) -ne 2) { throw 'USERNAME_CLICK_FAILED: could not target the username field' }
    Start-Sleep -Milliseconds 250
    if ([NativeInput]::SelectAll() -ne 4) { throw 'USERNAME_SELECT_FAILED: native input was blocked' }
    $expected = ([string]$creds.u).Length * 2
    if ([NativeInput]::SendUnicode([string]$creds.u) -ne $expected) { throw 'USERNAME_INPUT_FAILED: Windows blocked native username input' }
    Write-Output '{"checkpoint":"USERNAME_INPUT_INJECTED"}'

    # Revalidate ownership before each sensitive input stage. Chromium may
    # replace its HWND while hydrating; never continue typing into another app.
    Start-Sleep -Milliseconds 300
    Assert-TrustedRiotWindow $h
    if ([NativeInput]::ClickClient($h, 0.13, 0.37) -ne 2) { throw 'PASSWORD_CLICK_FAILED: could not target the password field' }
    Start-Sleep -Milliseconds 250
    if ([NativeInput]::SelectAll() -ne 4) { throw 'PASSWORD_SELECT_FAILED: native input was blocked' }
    $expected = ([string]$creds.p).Length * 2
    if ([NativeInput]::SendUnicode([string]$creds.p) -ne $expected) { throw 'PASSWORD_INPUT_FAILED: Windows blocked native password input' }
    Write-Output '{"checkpoint":"PASSWORD_INPUT_INJECTED"}'

    # Fresh-login flows clear Riot's auth state, so the checkbox starts
    # unchecked. Request persistence before submitting and click the form's
    # arrow button directly so checkbox focus cannot consume an Enter key.
    Start-Sleep -Milliseconds 300
    Assert-TrustedRiotWindow $h
    if ([NativeInput]::ClickClient($h, 0.042, 0.495) -ne 2) { throw 'STAY_SIGNED_IN_FAILED: could not target the Stay signed in checkbox' }
    Write-Output '{"checkpoint":"STAY_SIGNED_IN_CLICKED"}'
    Start-Sleep -Milliseconds 300
    Assert-TrustedRiotWindow $h
    if ([NativeInput]::ClickClient($h, 0.13, 0.75) -ne 2) { throw 'SUBMIT_FAILED: could not target the sign-in button' }
    Write-Output '{"checkpoint":"SUBMIT_CLICKED"}'

    [pscustomobject]@{
      ok = $true
      code = 'INPUT_SENT'
      staySignedInClicked = $true
      submittedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      processId = [NativeInput]::ProcessId($h)
      windowClass = [NativeInput]::ClassName($h)
      width = [NativeInput]::ClientWidth($h)
      height = [NativeInput]::ClientHeight($h)
    } | ConvertTo-Json -Compress
  `;
  const output = await ps(script, stdin, (line) => {
    try {
      const event = JSON.parse(line);
      if (event && event.checkpoint) onDiagnostic(event);
    } catch { /* non-checkpoint output is parsed below */ }
  }, 75000);
  try {
    const result = JSON.parse(output.split(/\r?\n/).filter(Boolean).pop());
    if (!result.ok) throw new Error(result.code || 'Native login input failed.');
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('INPUT_DIAGNOSTIC_FAILED: native input returned an unreadable result');
    throw error;
  }
}

/**
 * Full switch: kill -> launch -> wait -> auto-login.
 * @param {object} opts { clientPath, username, password, autoFill }
 * @param {function} onStep progress callback(stepLabel)
 */
async function switchAccount({
  clientPath,
  username,
  password,
  loginMode = 'native-required',
  configUrl = '',
  game = null,
  instant = false,
  onBeforeLaunch = null,
  onBeforeGameLaunch = null,
  onAfterGameLaunch = null,
  onRestoredSessionRejected = null,
  verifyAccount = null,
}, onStep = () => {}) {
  const progressSink = typeof onStep === 'function' ? onStep : () => {};
  onStep = (label) => progressSink(safeProgressLabel(label));
  const client = findRiotClient(clientPath);
  if (!client) throw new Error('Riot Client not found. Open Settings › Riot Client and set the path to RiotClientServices.exe.');
  if (loginMode === 'native-required' && !instant && !String(username || '').trim()) {
    throw new Error('LOGIN_USERNAME_MISSING: Edit this roster entry and add its Riot login username before switching.');
  }
  if (loginMode === 'native-required' && !instant && !password) {
    throw new Error('LOGIN_PASSWORD_MISSING: Edit this roster entry and save its password before switching.');
  }
  const manualLogin = loginMode !== 'native-required';
  const targetLabel = game && GAMES[game] ? GAMES[game].label : 'Riot Client';
  const stageProductLaunch = !!(game && typeof onBeforeGameLaunch === 'function');
  let configMigration = null;
  let launchedGame = null;
  let launchRequested = false;
  let launcherAccepted = false;
  let launchVerified = false;
  const launchVerifiedProduct = async () => {
    if (!game) return;
    try {
      if (stageProductLaunch) {
        onStep(`Preparing verified configuration before launching ${targetLabel}…`);
        configMigration = await onBeforeGameLaunch(onStep);
      }
      onStep(configUrl ? `Requesting ${targetLabel} launch (appearing offline)…` : `Requesting ${targetLabel} launch…`);
      launchRequested = true;
      const productLaunch = await launchProduct(client, { game, configUrl });
      launcherAccepted = productLaunch.launcherAccepted === true;
      launchVerified = productLaunch.launchVerified === true;
      onStep(launchVerified
        ? `${targetLabel} is starting.`
        : `Riot Client accepted the ${targetLabel} launch request. If it does not open, press PLAY in the Riot Client.`);
      if (typeof onAfterGameLaunch === 'function') {
        const postLaunch = await onAfterGameLaunch(configMigration, onStep);
        if (postLaunch && typeof postLaunch === 'object') configMigration = { ...(configMigration || {}), ...postLaunch };
      }
      launchedGame = launchVerified ? game : null;
    } catch (error) {
      error.code = 'PRE_GAME_LAUNCH_FAILED';
      throw error;
    }
  };
  const verify = async (phase = 'restore') => {
    if (typeof verifyAccount !== 'function') return { status: 'timeout' };
    try {
      const verification = await verifyAccount({ phase });
      if (!verification || typeof verification !== 'object') return { status: 'timeout' };
      return {
        ...verification,
        reason: verification.reason
          ? safeError(verification.reason, 'Riot identity verification did not complete.')
          : undefined,
      };
    } catch (error) {
      return { status: 'timeout', reason: safeError(error, 'Riot identity verification did not complete.') };
    }
  };

  onStep('Closing the current Riot session…');
  await killRiotProcesses();
  await delay(1500);
  if (onBeforeLaunch) {
    const preparation = await onBeforeLaunch(onStep);
    if (preparation && preparation.instant === false) instant = false;
    await delay(400);
  }
  if (!instant && manualLogin) {
    onStep('Automatic credential entry is off. Sign in to the requested account in Riot Client; this switch will resume after exact identity verification…');
  }

  const initialTarget = stageProductLaunch ? 'Riot Client for identity verification' : targetLabel;
  onStep(configUrl ? `Launching ${initialTarget} (appearing offline)…` : `Launching ${initialTarget}…`);
  const initialLaunch = await launchClient(client, { game: stageProductLaunch ? null : game, configUrl });
  if (!stageProductLaunch && game) {
    launchRequested = initialLaunch.productRequested === true;
    launcherAccepted = initialLaunch.launcherAccepted === true;
  }

  if (!instant && manualLogin) {
    const verificationAvailable = typeof verifyAccount === 'function';
    const verification = verificationAvailable ? await verify('manual') : { status: 'timeout' };
    const verified = verification.status === 'matched';
    if (verified) await launchVerifiedProduct();
    onStep(verified
      ? 'Requested account verified; the automatic switch is continuing.'
      : 'Manual sign-in was left open because the requested PUUID was not verified before the timeout.');
    return {
      instant: false,
      fallback: false,
      verified,
      recoverable: !verified && verification.status !== 'mismatched',
      awaitingUserVerification: !verified && verification.status !== 'mismatched',
      verification,
      verificationAvailable,
      automationAttempted: false,
      inputDelivered: false,
      loginSubmitted: false,
      staySignedInClicked: false,
      manualRequired: !verified,
      reason: verified ? undefined : 'Complete sign-in to the requested account, then retry if Riot Relay did not resume automatically.',
      launchedGame,
      launchRequested,
      launcherAccepted,
      launchVerified,
      configMigration,
    };
  }

  let fallback = false;
  let restoredVerification = null;
  if (instant) {
    onStep('Verifying the restored Riot session…');
    restoredVerification = await verify();
    if (restoredVerification.status === 'matched') {
      await launchVerifiedProduct();
      onStep('Saved session verified — requested account is active.');
      return {
        instant: true, fallback: false, verified: true, verification: restoredVerification,
        launchedGame, launchRequested, launcherAccepted, launchVerified, configMigration,
      };
    }
    if (restoredVerification.status === 'timeout') {
      onStep('Riot is still starting; leaving it open without restarting.');
      return {
        instant: true,
        fallback: false,
        verified: false,
        recoverable: true,
        verification: restoredVerification,
        reason: 'Riot did not expose a stable identity before the verification timeout.',
      };
    }
    // A stable wrong identity or repeated explicit 401/404 response means Riot
    // rejected this snapshot. Remove it before any credential fallback so it is
    // not advertised as a working saved session on the next launch.
    if (typeof onRestoredSessionRejected === 'function') {
      await onRestoredSessionRejected(restoredVerification, onStep);
    }
    if (loginMode !== 'native-required') {
      onStep('The saved session needs sign-in and automatic login is disabled.');
      return {
        instant: true,
        fallback: false,
        verified: false,
        recoverable: true,
        verification: restoredVerification,
        manualRequired: true,
        reason: 'AUTO_LOGIN_DISABLED: Saved session needs sign-in; enable automatic login in Settings.',
      };
    }

    fallback = true;
    if (restoredVerification.status === 'mismatched') {
      // Only a stable, positively identified wrong account warrants a restart.
      onStep('Restored session belongs to another account — reopening one clean sign-in form…');
      await killRiotProcesses();
      await delay(1200);
      clearRiotSession();
      await launchClient(client, { game: stageProductLaunch ? null : game, configUrl });
    } else {
      // Expired snapshots already leave a usable login form open. Reuse it;
      // killing/relaunching here caused the visible open/close/open loop.
      onStep('Saved session needs sign-in — using the open Riot login form…');
    }
  }

  if (!String(username || '').trim() || !password) {
    const reason = !String(username || '').trim()
      ? 'LOGIN_USERNAME_MISSING: Add the Riot login username to this roster entry.'
      : 'LOGIN_PASSWORD_MISSING: Save the Riot password on this roster entry.';
    onStep(reason);
    return {
      instant,
      fallback,
      verified: false,
      recoverable: true,
      verification: restoredVerification,
      automationAttempted: false,
      inputDelivered: false,
      manualRequired: true,
      reason,
    };
  }

  onStep('Waiting for and targeting the Riot login form…');
  try {
    const input = await autoLogin(username, password, client, (event) => {
      const labels = {
        HELPER_STARTED: 'Secure login helper started.',
        WINDOW_DETECTED: 'Trusted Riot window detected; waiting for the login form…',
        WINDOW_SELECTED: 'Trusted Riot window is stable.',
        FORM_SETTLE_WAIT_COMPLETE: 'Riot login form is ready.',
        FOREGROUND_ACQUIRED: 'Riot login form is active.',
        USERNAME_INPUT_INJECTED: 'Username entered securely.',
        PASSWORD_INPUT_INJECTED: 'Password entered securely.',
        STAY_SIGNED_IN_CLICKED: 'Stay signed in selected.',
        SUBMIT_CLICKED: 'Riot sign-in submitted.',
      };
      if (labels[event.checkpoint]) onStep(labels[event.checkpoint]);
    });
    onStep('Credentials submitted. Complete Riot 2FA or any verification challenge in the Riot Client if prompted…');
    const verificationAvailable = typeof verifyAccount === 'function';
    const verification = verificationAvailable ? await verify('post-login') : { status: 'timeout' };
    const verified = verification.status === 'matched';
    const authenticationNotConfirmed = !verified && verification.status === 'authentication-not-confirmed';
    if (verified) await launchVerifiedProduct();
    onStep(verified
      ? 'Requested account verified.'
      : (verification.status === 'mismatched'
        ? 'Riot signed into a different identity; the switch was rejected.'
        : authenticationNotConfirmed
          ? 'Riot did not authenticate; saved credentials or a verification challenge need attention.'
          : 'Input was delivered, but Riot has not confirmed the requested account yet.'));
    return {
      instant: false,
      fallback,
      verified,
      recoverable: !verified && verification.status !== 'mismatched',
      awaitingUserVerification: !verified && (verification.status === 'unauthenticated'
        || verification.status === 'authentication-not-confirmed' || verification.status === 'timeout'),
      authenticationNotConfirmed,
      credentialAttention: authenticationNotConfirmed,
      reason: authenticationNotConfirmed ? verification.reason : undefined,
      verification,
      verificationAvailable,
      automationAttempted: true,
      inputDelivered: true,
      loginSubmitted: true,
      staySignedInClicked: !!input.staySignedInClicked,
      submittedAt: Number(input.submittedAt || Date.now()),
      manualRequired: false,
      inputCode: input.code,
      launchedGame,
      launchRequested,
      launcherAccepted,
      launchVerified,
      configMigration,
    };
  } catch (e) {
    if (e && e.code === 'PRE_GAME_LAUNCH_FAILED') throw e;
    const reason = safeError(e, 'Automatic form input failed.');
    onStep('Automatic form input failed. Complete sign-in manually in Riot Client.');
    return {
      instant: false,
      fallback,
      verified: false,
      verification: restoredVerification,
      verificationAvailable: typeof verifyAccount === 'function',
      automationAttempted: true,
      inputDelivered: false,
      loginSubmitted: false,
      staySignedInClicked: false,
      manualRequired: true,
      reason,
    };
  }
}

module.exports = {
  switchAccount, launchClient, launchProduct, waitForProductStart,
  killRiotProcesses, findRiotClient, clearRiotSession, GAMES,
};
