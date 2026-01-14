const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const axios = require('axios');
const os = require('os');

let mainWindow;

// Minecraft dizinleri
const MINECRAFT_DIR = path.join(os.homedir(), '.minecraft');
const VERSIONS_DIR = path.join(MINECRAFT_DIR, 'versions');
const LIBRARIES_DIR = path.join(MINECRAFT_DIR, 'libraries');
const ASSETS_DIR = path.join(MINECRAFT_DIR, 'assets');

// Dizinleri oluştur
async function initDirectories() {
  const dirs = [MINECRAFT_DIR, VERSIONS_DIR, LIBRARIES_DIR, ASSETS_DIR];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    icon: path.join(__dirname, 'icon.ico'), // Windows için .ico
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true,
    resizable: false,
    frame: true
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  await initDirectories();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Minecraft versiyonlarını getir
ipcMain.handle('get-versions', async () => {
  try {
    const response = await axios.get(
      'https://launchermeta.mojang.com/mc/game/version_manifest.json'
    );

    return response.data.versions
      // tüm sürümler
      .filter(v =>
        v.type === 'release' ||
        v.type === 'old_release' ||
        v.type === 'snapshot'
      )
      // yeniden eskiye sırala
      .sort((a, b) => new Date(b.releaseTime) - new Date(a.releaseTime));

  } catch (error) {
    console.error('Version fetch error:', error);
    return [];
  }
});


// Versiyon indir
ipcMain.handle('download-version', async (event, versionId) => {
  try {
    // Version manifest'i al
    const manifestResponse = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    const version = manifestResponse.data.versions.find(v => v.id === versionId);
    
    if (!version) throw new Error('Version not found');

    // Version JSON'unu indir
    const versionJsonResponse = await axios.get(version.url);
    const versionData = versionJsonResponse.data;

    // Version dizinini oluştur
    const versionDir = path.join(VERSIONS_DIR, versionId);
    await fs.mkdir(versionDir, { recursive: true });

    // Version JSON'unu kaydet
    await fs.writeFile(
      path.join(versionDir, `${versionId}.json`),
      JSON.stringify(versionData, null, 2)
    );

    // Client JAR'ı indir
    const jarPath = path.join(versionDir, `${versionId}.jar`);
    const jarResponse = await axios.get(versionData.downloads.client.url, {
      responseType: 'arraybuffer',
      onDownloadProgress: (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        mainWindow.webContents.send('download-progress', percentCompleted);
      }
    });
    
    await fs.writeFile(jarPath, Buffer.from(jarResponse.data));

    // Libraries'i indir (basitleştirilmiş - sadece natives olmayan)
    let downloadedLibs = 0;
    const libraries = versionData.libraries.filter(lib => !lib.natives);
    
    for (const lib of libraries) {
      if (lib.downloads && lib.downloads.artifact) {
        const artifact = lib.downloads.artifact;
        const libPath = path.join(LIBRARIES_DIR, artifact.path);
        
        // Dizini oluştur
        await fs.mkdir(path.dirname(libPath), { recursive: true });
        
        try {
          // Dosya zaten varsa atla
          await fs.access(libPath);
        } catch {
          // Dosya yoksa indir
          const libResponse = await axios.get(artifact.url, { responseType: 'arraybuffer' });
          await fs.writeFile(libPath, Buffer.from(libResponse.data));
        }
        
        downloadedLibs++;
        const progress = Math.round((downloadedLibs / libraries.length) * 100);
        mainWindow.webContents.send('library-progress', progress);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Download error:', error);
    return { success: false, error: error.message };
  }
});

// Java yolunu bul
async function findJavaPath() {
  const possiblePaths = [
    'java',
    'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.1.12-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9.9-hotspot\\bin\\java.exe'
  ];

  for (const javaPath of possiblePaths) {
    try {
      const { execSync } = require('child_process');
      execSync(`"${javaPath}" -version`, { stdio: 'pipe' });
      return javaPath;
    } catch (e) {
      continue;
    }
  }
  
  return 'java'; // Varsayılan
}

// Oyunu başlat
ipcMain.handle('launch-game', async (event, versionId, username) => {
  try {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const versionJsonPath = path.join(versionDir, `${versionId}.json`);
    const versionJson = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));

    // Classpath oluştur
    const classpath = [];
    
    // Libraries ekle
    for (const lib of versionJson.libraries) {
      if (lib.downloads && lib.downloads.artifact && !lib.natives) {
        const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
        classpath.push(libPath);
      }
    }
    
    // Client JAR ekle
    classpath.push(path.join(versionDir, `${versionId}.jar`));

    // Java path
    const javaPath = await findJavaPath();

    // Launch arguments
    const args = [
      '-Xmx2G',
      '-Xms512M',
      `-Djava.library.path=${path.join(VERSIONS_DIR, versionId, 'natives')}`,
      '-cp',
      classpath.join(process.platform === 'win32' ? ';' : ':'),
      versionJson.mainClass,
      '--username', username || 'Player',
      '--version', versionId,
      '--gameDir', MINECRAFT_DIR,
      '--assetsDir', ASSETS_DIR,
      '--assetIndex', versionJson.assetIndex.id,
      '--uuid', '00000000-0000-0000-0000-000000000000',
      '--accessToken', '0',
      '--userType', 'legacy',
      '--versionType', 'release'
    ];

    console.log('Launching with:', javaPath, args);

    // Oyunu başlat
    const gameProcess = spawn(javaPath, args, {
      cwd: MINECRAFT_DIR,
      detached: true
    });

    gameProcess.stdout.on('data', (data) => {
      console.log(`Game: ${data}`);
      mainWindow.webContents.send('game-log', data.toString());
    });

    gameProcess.stderr.on('data', (data) => {
      console.error(`Game Error: ${data}`);
      mainWindow.webContents.send('game-log', data.toString());
    });

    gameProcess.on('close', (code) => {
      console.log(`Game closed with code ${code}`);
      mainWindow.webContents.send('game-closed', code);
    });

    return { success: true };
  } catch (error) {
    console.error('Launch error:', error);
    return { success: false, error: error.message };
  }
});

// İndirilen versiyonları listele
ipcMain.handle('get-installed-versions', async () => {
  try {
    const versions = await fs.readdir(VERSIONS_DIR);
    return versions;
  } catch (error) {
    return [];
  }
});