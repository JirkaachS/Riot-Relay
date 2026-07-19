'use strict';

const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 12000;

function safeMessage(error) {
  return String(error && error.message || error || 'Update service error.')
    .replace(/https?:\/\/\S+/gi, 'GitHub update service')
    .replace(/[A-Z]:\\[^\r\n]*/gi, 'local update path')
    .slice(0, 220);
}

class UpdateService {
  constructor({ app, installerFlavor, emit, canInstall }) {
    this.app = app;
    this.installerFlavor = String(installerFlavor || 'unknown');
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.canInstall = typeof canInstall === 'function' ? canInstall : () => true;
    this.started = false;
    this.checkTimer = null;
    this.interval = null;
    this.state = {
      supported: app.isPackaged && process.platform === 'win32' && this.installerFlavor !== 'msi',
      installerFlavor: this.installerFlavor,
      status: 'idle',
      currentVersion: app.getVersion(),
      availableVersion: null,
      progress: 0,
      lastCheckedAt: null,
      error: null,
    };
  }

  snapshot() { return { ...this.state }; }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit(this.snapshot());
    return this.snapshot();
  }

  start() {
    if (this.started) return this.snapshot();
    this.started = true;
    if (!this.state.supported) {
      const reason = this.installerFlavor === 'msi'
        ? 'MSI installations are updated manually or by your administrator.'
        : 'Automatic updates are available in installed Windows EXE builds.';
      return this.setState({ status: 'unsupported', error: reason });
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.setState({
      status: 'available', availableVersion: String(info && info.version || ''), error: null,
    }));
    autoUpdater.on('update-not-available', () => this.setState({
      status: 'current', availableVersion: null, progress: 0,
      lastCheckedAt: new Date().toISOString(), error: null,
    }));
    autoUpdater.on('download-progress', (progress) => this.setState({
      status: 'downloading', progress: Math.max(0, Math.min(100, Number(progress && progress.percent) || 0)), error: null,
    }));
    autoUpdater.on('update-downloaded', (info) => this.setState({
      status: 'downloaded', availableVersion: String(info && info.version || this.state.availableVersion || ''),
      progress: 100, lastCheckedAt: new Date().toISOString(), error: null,
    }));
    autoUpdater.on('error', (error) => this.setState({
      status: 'error', error: safeMessage(error), lastCheckedAt: new Date().toISOString(),
    }));

    this.checkTimer = setTimeout(() => this.check(false), STARTUP_DELAY_MS);
    this.interval = setInterval(() => this.check(false), CHECK_INTERVAL_MS);
    if (this.checkTimer.unref) this.checkTimer.unref();
    if (this.interval.unref) this.interval.unref();
    this.emit(this.snapshot());
    return this.snapshot();
  }

  async check(manual = true) {
    if (!this.state.supported) return this.snapshot();
    if (['checking', 'downloading'].includes(this.state.status)) return this.snapshot();
    this.setState({ status: 'checking', error: null });
    try {
      await autoUpdater.checkForUpdates();
      this.state.lastCheckedAt = new Date().toISOString();
    } catch (error) {
      this.setState({ status: 'error', error: safeMessage(error), lastCheckedAt: new Date().toISOString() });
      if (manual) throw new Error(this.state.error);
    }
    return this.snapshot();
  }

  install() {
    if (!this.state.supported) throw new Error('Automatic installation is unavailable for this package.');
    if (this.state.status !== 'downloaded') throw new Error('No downloaded update is ready to install.');
    if (!this.canInstall()) throw new Error('Finish the active account switch or chat operation before restarting to update.');
    this.setState({ status: 'installing', error: null });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return this.snapshot();
  }

  dispose() {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.interval) clearInterval(this.interval);
    this.checkTimer = null;
    this.interval = null;
  }
}

module.exports = { UpdateService };
