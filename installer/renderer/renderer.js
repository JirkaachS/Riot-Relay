'use strict';

const $ = (sel) => document.querySelector(sel);

$('#btn-minimize').addEventListener('click', () => window.setupApi.windowAction('minimize'));
$('#btn-close').addEventListener('click', () => window.setupApi.windowAction('close'));

const INSTALL_FLOW = ['welcome', 'license', 'location', 'progress', 'finish'];
const UNINSTALL_FLOW = ['uninstall-confirm', 'progress', 'finish'];

const state = {
  mode: 'install',
  flow: INSTALL_FLOW,
  stepIndex: 0,
  context: null,
  installDir: '',
  result: null,
};

function renderSteps() {
  const stepLabels = {
    welcome: 'Welcome', license: 'License', location: 'Location', progress: 'Install', finish: 'Finish',
    'uninstall-confirm': 'Confirm',
  };
  const rail = $('#wizard-steps');
  rail.innerHTML = state.flow.map((key, index) => {
    const cls = index === state.stepIndex ? 'is-active' : index < state.stepIndex ? 'is-done' : '';
    return `<li class="${cls}">${stepLabels[key] || key}</li>`;
  }).join('');
}

function showPage(key) {
  document.querySelectorAll('.page').forEach((el) => { el.hidden = el.dataset.page !== key; });
}

function currentPageKey() { return state.flow[state.stepIndex]; }

function updateNavButtons() {
  const key = currentPageKey();
  const isFirst = state.stepIndex === 0;
  const isLast = state.stepIndex === state.flow.length - 1;
  $('#btn-back').hidden = isFirst || key === 'progress' || key === 'finish';
  $('#btn-cancel').hidden = key === 'progress' || key === 'finish';
  $('#btn-next').hidden = key === 'progress';
  $('#btn-next').textContent = key === 'finish' ? 'Finish'
    : key === 'location' ? 'Install'
      : key === 'uninstall-confirm' ? 'Uninstall'
        : 'Next';
  $('#btn-next').disabled = key === 'license' && !$('#license-accept').checked;
}

async function goTo(index) {
  state.stepIndex = Math.max(0, Math.min(state.flow.length - 1, index));
  renderSteps();
  showPage(currentPageKey());
  updateNavButtons();
  if (currentPageKey() === 'progress') await runProgressStep();
}

async function runProgressStep() {
  $('#progress-error').hidden = true;
  $('#progress-fill').style.width = '0%';
  const unsubscribe = window.setupApi.onProgress(({ percent, label }) => {
    $('#progress-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    $('#progress-label').textContent = label || '';
  });
  try {
    if (state.mode === 'install') {
      $('#progress-title').textContent = 'Installing Riot Relay';
      state.result = await window.setupApi.startInstall({
        installDir: state.installDir,
        createDesktopShortcut: $('#opt-desktop').checked,
        createStartMenuShortcut: $('#opt-startmenu').checked,
      });
    } else {
      $('#progress-title').textContent = 'Uninstalling Riot Relay';
      state.result = await window.setupApi.startUninstall({
        installDir: state.installDir,
        keepUserData: $('#opt-keep-data').checked,
      });
    }
  } finally {
    unsubscribe();
  }
  if (!state.result.success) {
    $('#progress-error').hidden = false;
    $('#progress-error').textContent = `Something went wrong: ${state.result.error || 'unknown error.'}`;
    $('#btn-back').hidden = false;
    $('#btn-cancel').hidden = false;
    $('#btn-next').hidden = true;
    return;
  }
  prepareFinishPage();
  await goTo(state.stepIndex + 1);
}

function prepareFinishPage() {
  if (state.mode === 'install') {
    $('#finish-title').textContent = 'Setup Complete';
    $('#finish-body').textContent = `Riot Relay ${state.context.version} has been installed on this computer.`;
    $('#launch-row').hidden = false;
  } else {
    $('#finish-title').textContent = 'Uninstall Complete';
    $('#finish-body').textContent = 'Riot Relay has been removed from this computer.';
    $('#launch-row').hidden = true;
  }
}

async function handleNext() {
  const key = currentPageKey();
  if (key === 'license' && !$('#license-accept').checked) return;
  if (key === 'finish') {
    if (state.mode === 'install' && $('#opt-launch').checked && state.result && state.result.exePath) {
      await window.setupApi.launchApp(state.result.exePath);
    }
    await window.setupApi.quit();
    return;
  }
  await goTo(state.stepIndex + 1);
}

async function handleBack() {
  await goTo(state.stepIndex - 1);
}

$('#btn-next').addEventListener('click', handleNext);
$('#btn-back').addEventListener('click', handleBack);
$('#btn-cancel').addEventListener('click', () => window.setupApi.quit());
$('#license-accept').addEventListener('change', updateNavButtons);

$('#btn-browse').addEventListener('click', async () => {
  const chosen = await window.setupApi.chooseDirectory(state.installDir);
  if (chosen) {
    state.installDir = chosen;
    $('#install-dir').value = chosen;
  }
});

async function init() {
  const context = await window.setupApi.getContext();
  state.context = context;
  state.mode = context.mode;
  state.flow = context.mode === 'uninstall' ? UNINSTALL_FLOW : INSTALL_FLOW;
  state.installDir = context.installDir;

  $('#titlebar-title').textContent = context.mode === 'uninstall' ? 'Riot Relay Uninstall' : 'Riot Relay Setup';
  $('#welcome-title').textContent = `Welcome to ${context.productName} Setup`;
  $('#welcome-body').textContent = `This will install ${context.productName} ${context.version} on this computer. ${context.productName} is unofficial community software and is not endorsed by Riot Games.`;
  $('#license-text').value = context.licenseText || '';
  $('#install-dir').value = context.installDir;
  $('#uninstall-location-text').textContent = `This will remove ${context.productName} from: ${context.installDir}`;

  renderSteps();
  showPage(currentPageKey());
  updateNavButtons();
}

init();
