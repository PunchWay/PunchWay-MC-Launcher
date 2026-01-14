const versionSelect = document.getElementById('version-select');
const downloadBtn = document.getElementById('download-btn');
const launchBtn = document.getElementById('launch-btn');
const refreshBtn = document.getElementById('refresh-btn');
const usernameInput = document.getElementById('username');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const logDiv = document.getElementById('log');
const installedVersionsDiv = document.getElementById('installed-versions');
const snapshotToggle = document.getElementById('snapshot-toggle');

let currentVersions = [];
let installedVersions = [];

/* ---------------- LOG ---------------- */

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logDiv.innerHTML += `[${timestamp}] ${message}\n`;
  logDiv.scrollTop = logDiv.scrollHeight;
}

/* ---------------- PROGRESS ---------------- */

function showProgress(percent, text) {
  progressSection.style.display = 'block';
  progressFill.style.width = percent + '%';
  progressFill.textContent = percent + '%';
  progressText.textContent = text;
}

function hideProgress() {
  progressSection.style.display = 'none';
  progressFill.style.width = '0%';
}

/* ---------------- LOAD VERSIONS ---------------- */

async function loadVersions() {
  log('Minecraft Ver. is Loading...');

  let versions;
  try {
    versions = await window.electronAPI.getVersions();
  } catch (err) {
    console.error(err);
    log('getVersions ERROR');
    return;
  }

  if (!versions || versions.length === 0) {
    log('Ver. Cant Load!');
    return;
  }

  const showSnapshots = snapshotToggle ? snapshotToggle.checked : false;

  currentVersions = versions;
  versionSelect.innerHTML =
    '<option value="">Select The Ver. You Want To Play</option>';

  versions.forEach(version => {
    // 🔹 Eğer string geldiyse (eski sistem)
    if (typeof version === 'string') {
      const option = document.createElement('option');
      option.value = version;
      option.textContent = version;
      versionSelect.appendChild(option);
      return;
    }

    // 🔹 Object geldiyse (snapshot destekli)
    if (
      version.type === 'release' ||
      (showSnapshots && version.type === 'snapshot')
    ) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent =
        version.id + (version.type === 'snapshot' ? ' (Snapshot)' : '');

      if (version.type === 'snapshot') {
        option.style.color = '#ff9800';
      }

      versionSelect.appendChild(option);
    }
  });

  log(
    `Loaded ${
      versionSelect.options.length - 1
    } Ver. ${showSnapshots ? '(Snapshots ON)' : '(Snapshots OFF)'}`
  );
}

/* ---------------- INSTALLED VERSIONS ---------------- */

async function loadInstalledVersions() {
  installedVersions = await window.electronAPI.getInstalledVersions();

  if (!installedVersions || installedVersions.length === 0) {
    installedVersionsDiv.innerHTML =
      '<span class="info-text">Downloaded Ver. None</span>';
    return;
  }

  installedVersionsDiv.innerHTML = '';
  installedVersions.forEach(version => {
    const tag = document.createElement('span');
    tag.className = 'version-tag';
    tag.textContent = version;
    installedVersionsDiv.appendChild(tag);
  });
}

/* ---------------- BUTTONS ---------------- */

downloadBtn.addEventListener('click', async () => {
  const selectedVersion = versionSelect.value;
  if (!selectedVersion) return log('Please Select Ver!');

  if (installedVersions.includes(selectedVersion))
    return log('This Ver. Already Installed!');

  downloadBtn.disabled = true;
  launchBtn.disabled = true;

  log(`📦 ${selectedVersion} Downloading...`);
  showProgress(0, 'Client JAR Downloading...');

  const result = await window.electronAPI.downloadVersion(selectedVersion);

  hideProgress();
  downloadBtn.disabled = false;
  launchBtn.disabled = false;

  if (result.success) {
    log(`${selectedVersion} Successfully Installed!`);
    loadInstalledVersions();
  } else {
    log(`Download Error: ${result.error}`);
  }
});

launchBtn.addEventListener('click', async () => {
  const selectedVersion = versionSelect.value;
  const username = usernameInput.value.trim() || 'Player';

  if (!selectedVersion) return log('Please Select Ver');
  if (!installedVersions.includes(selectedVersion))
    return log('This Ver. is not installed!');

  downloadBtn.disabled = true;
  launchBtn.disabled = true;

  log(`🚀 Minecraft ${selectedVersion} Starting...`);
  log(`👤 User: ${username}`);

  const result = await window.electronAPI.launchGame(selectedVersion, username);

  if (!result.success) {
    log(`Launch Error: ${result.error}`);
    downloadBtn.disabled = false;
    launchBtn.disabled = false;
  }
});

/* ---------------- EVENTS ---------------- */

refreshBtn.addEventListener('click', () => {
  loadVersions();
  loadInstalledVersions();
});

window.electronAPI.onDownloadProgress(p =>
  showProgress(p, 'Client JAR Downloading...')
);

window.electronAPI.onLibraryProgress(p =>
  showProgress(p, 'Downloading Libraries...')
);

window.electronAPI.onGameLog(msg => log(msg.trim()));

window.electronAPI.onGameClosed(code => {
  log(`Game Closed (code: ${code})`);
  downloadBtn.disabled = false;
  launchBtn.disabled = false;
});

/* ---------------- SNAPSHOT TOGGLE ---------------- */

snapshotToggle.checked =
  localStorage.getItem('showSnapshots') === 'true';

snapshotToggle.addEventListener('change', () => {
  localStorage.setItem('showSnapshots', snapshotToggle.checked);
  loadVersions();
});

/* ---------------- STARTUP ---------------- */

loadVersions();
loadInstalledVersions();
log('Launcher is ready!');
