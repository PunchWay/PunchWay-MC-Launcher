const { app, BrowserWindow, ipcMain } = require('electron'); 
const path = require('path'); 
const fs = require('fs').promises; 
const { spawn, execSync } = require('child_process'); 
const axios = require('axios'); 
const os = require('os'); 
const AdmZip = require('adm-zip');
 
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
    icon: path.join(__dirname, 'icon.ico'),
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
      .filter(v => 
        v.type === 'release' || 
        v.type === 'old_release' || 
        v.type === 'snapshot' 
      ) 
      .sort((a, b) => new Date(b.releaseTime) - new Date(a.releaseTime)); 
 
  } catch (error) { 
    console.error('Version fetch error:', error); 
    return []; 
  } 
}); 

// Get OS-specific natives classifier
function getNativesClassifier() {
  const platform = os.platform();
  
  if (platform === 'win32') {
    return 'natives-windows';
  } else if (platform === 'darwin') {
    return 'natives-osx';
  } else if (platform === 'linux') {
    return 'natives-linux';
  }
  return 'natives-windows';
}

// Download and extract native libraries
async function downloadNatives(versionData, versionId) {
  const nativesDir = path.join(VERSIONS_DIR, versionId, 'natives');
  
  // Clear existing natives directory to prevent conflicts
  try {
    await fs.rm(nativesDir, { recursive: true, force: true });
  } catch (e) {
    // Directory doesn't exist, that's fine
  }
  
  await fs.mkdir(nativesDir, { recursive: true });
  
  console.log(`Extracting natives to: ${nativesDir}`);
  
  let nativesCount = 0;
  let processedLibs = 0;
  
  for (const lib of versionData.libraries) {
    // Skip if library has rules that don't match our platform
    if (lib.rules) {
      let allowed = false;
      for (const rule of lib.rules) {
        if (rule.action === 'allow') {
          if (!rule.os) {
            allowed = true;
          } else if (rule.os.name === 'windows' && os.platform() === 'win32') {
            allowed = true;
          } else if (rule.os.name === 'osx' && os.platform() === 'darwin') {
            allowed = true;
          } else if (rule.os.name === 'linux' && os.platform() === 'linux') {
            allowed = true;
          }
        } else if (rule.action === 'disallow') {
          if (rule.os && rule.os.name === 'windows' && os.platform() === 'win32') {
            allowed = false;
          } else if (rule.os && rule.os.name === 'osx' && os.platform() === 'darwin') {
            allowed = false;
          } else if (rule.os && rule.os.name === 'linux' && os.platform() === 'linux') {
            allowed = false;
          }
        }
      }
      if (!allowed) {
        continue;
      }
    }
    
    // Check if library has natives for current platform
    if (lib.natives && lib.downloads && lib.downloads.classifiers) {
      // Get the correct native key based on platform
      let nativeKey;
      if (os.platform() === 'win32') {
        nativeKey = lib.natives.windows;
      } else if (os.platform() === 'darwin') {
        nativeKey = lib.natives.osx;
      } else if (os.platform() === 'linux') {
        nativeKey = lib.natives.linux;
      }
      
      // Replace ${arch} variable if present
      if (nativeKey && nativeKey.includes('${arch}')) {
        const arch = os.arch() === 'x64' ? '64' : '32';
        nativeKey = nativeKey.replace('${arch}', arch);
      }
      
      if (nativeKey) {
        const nativeArtifact = lib.downloads.classifiers[nativeKey];
        
        if (nativeArtifact) {
          processedLibs++;
          console.log(`Downloading native: ${lib.name} (${nativeKey})`);
          
          try {
            const response = await axios.get(nativeArtifact.url, { 
              responseType: 'arraybuffer',
              timeout: 30000
            });
            
            // Extract natives from JAR
            const zip = new AdmZip(Buffer.from(response.data));
            const zipEntries = zip.getEntries();
            
            // Get extract rules if they exist
            const extractRules = lib.extract || {};
            const excludePatterns = extractRules.exclude || [];
            
            for (const entry of zipEntries) {
              // Skip directories
              if (entry.isDirectory) continue;
              
              // Check if file should be excluded
              let shouldExclude = false;
              for (const pattern of excludePatterns) {
                if (entry.entryName.startsWith(pattern)) {
                  shouldExclude = true;
                  break;
                }
              }
              
              if (shouldExclude) continue;
              
              // Skip META-INF by default
              if (entry.entryName.startsWith('META-INF/')) continue;
              
              const fileName = path.basename(entry.entryName);
              
              // Check for native library files
              const isNative = fileName.endsWith('.dll') || 
                              fileName.endsWith('.so') || 
                              fileName.endsWith('.dylib') ||
                              fileName.endsWith('.jnilib');
              
              if (isNative) {
                const targetPath = path.join(nativesDir, fileName);
                await fs.writeFile(targetPath, entry.getData());
                console.log(`Extracted: ${fileName}`);
                nativesCount++;
              }
            }
          } catch (error) {
            console.error(`Failed to download native ${lib.name}:`, error.message);
            // Don't throw, just log - some natives might be optional
          }
        }
      }
    }
  }
  
  console.log(`Processed ${processedLibs} native libraries, extracted ${nativesCount} files to ${nativesDir}`);
  
  // Only throw error if no natives at all - some versions might have different structures
  if (processedLibs > 0 && nativesCount === 0) {
    console.error('WARNING: Native libraries were found but none were extracted!');
  }
  
  // List extracted files for debugging
  try {
    const files = await fs.readdir(nativesDir);
    console.log('Native files in directory:', files);
    
    if (files.length === 0) {
      console.warn('No native files extracted - this may cause launch issues');
    }
  } catch (e) {
    console.error('Could not read natives directory:', e);
  }
  
  return nativesDir;
}

// Asset indirme fonksiyonu - YENİ!
async function downloadAssets(versionData, versionId) {
  try {
    // Asset index dosyasını indir
    const assetIndexUrl = versionData.assetIndex.url;
    const assetIndexId = versionData.assetIndex.id;
    
    const indexesDir = path.join(ASSETS_DIR, 'indexes');
    await fs.mkdir(indexesDir, { recursive: true });
    
    const assetIndexPath = path.join(indexesDir, `${assetIndexId}.json`);
    
    console.log(`Downloading asset index: ${assetIndexId}`);
    mainWindow.webContents.send('download-status', 'Downloading asset index...');
    
    const indexResponse = await axios.get(assetIndexUrl);
    await fs.writeFile(assetIndexPath, JSON.stringify(indexResponse.data, null, 2));
    
    const assetIndex = indexResponse.data;
    const objects = assetIndex.objects;
    const objectsDir = path.join(ASSETS_DIR, 'objects');
    
    const totalAssets = Object.keys(objects).length;
    let downloadedAssets = 0;
    
    console.log(`Total assets to download: ${totalAssets}`);
    mainWindow.webContents.send('download-status', `Downloading ${totalAssets} assets (sounds, music, textures)...`);
    
    // Asset'leri indir
    for (const [assetName, assetData] of Object.entries(objects)) {
      const hash = assetData.hash;
      const subDir = hash.substring(0, 2);
      const assetDir = path.join(objectsDir, subDir);
      const assetPath = path.join(assetDir, hash);
      
      // Dosya zaten varsa atla
      try {
        await fs.access(assetPath);
        downloadedAssets++;
        
        // İlerleme gönder
        if (downloadedAssets % 50 === 0) {
          const progress = Math.round((downloadedAssets / totalAssets) * 100);
          mainWindow.webContents.send('asset-progress', progress);
        }
        continue;
      } catch {
        // Dosya yok, indir
      }
      
      await fs.mkdir(assetDir, { recursive: true });
      
      const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;
      
      try {
        const response = await axios.get(assetUrl, { 
          responseType: 'arraybuffer',
          timeout: 30000
        });
        
        await fs.writeFile(assetPath, Buffer.from(response.data));
        downloadedAssets++;
        
        // İlerleme gönder (her 50 asset'te bir)
        if (downloadedAssets % 50 === 0) {
          const progress = Math.round((downloadedAssets / totalAssets) * 100);
          mainWindow.webContents.send('asset-progress', progress);
          console.log(`Downloaded ${downloadedAssets}/${totalAssets} assets (${progress}%)`);
        }
      } catch (error) {
        console.error(`Failed to download asset ${assetName}:`, error.message);
        // Hata olsa bile devam et
      }
    }
    
    console.log(`Asset download complete: ${downloadedAssets}/${totalAssets}`);
    mainWindow.webContents.send('download-status', 'Assets downloaded successfully!');
    mainWindow.webContents.send('asset-progress', 100);
    
    return { success: true, downloaded: downloadedAssets, total: totalAssets };
  } catch (error) {
    console.error('Asset download error:', error);
    mainWindow.webContents.send('download-status', 'Asset download failed, but game may still work');
    return { success: false, error: error.message };
  }
}
 
// Versiyon indir 
ipcMain.handle('download-version', async (event, versionId) => { 
  try { 
    const manifestResponse = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json'); 
    const version = manifestResponse.data.versions.find(v => v.id === versionId); 
     
    if (!version) throw new Error('Version not found'); 
 
    const versionJsonResponse = await axios.get(version.url); 
    const versionData = versionJsonResponse.data; 
 
    const versionDir = path.join(VERSIONS_DIR, versionId); 
    await fs.mkdir(versionDir, { recursive: true }); 
 
    await fs.writeFile( 
      path.join(versionDir, `${versionId}.json`), 
      JSON.stringify(versionData, null, 2) 
    ); 
 
    const jarPath = path.join(versionDir, `${versionId}.jar`); 
    const jarResponse = await axios.get(versionData.downloads.client.url, { 
      responseType: 'arraybuffer', 
      onDownloadProgress: (progressEvent) => { 
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total); 
        mainWindow.webContents.send('download-progress', percentCompleted); 
      } 
    }); 
     
    await fs.writeFile(jarPath, Buffer.from(jarResponse.data)); 
 
    let downloadedLibs = 0; 
    const libraries = versionData.libraries.filter(lib => !lib.natives); 
     
    for (const lib of libraries) { 
      if (lib.downloads && lib.downloads.artifact) { 
        const artifact = lib.downloads.artifact; 
        const libPath = path.join(LIBRARIES_DIR, artifact.path); 
         
        await fs.mkdir(path.dirname(libPath), { recursive: true }); 
         
        try { 
          await fs.access(libPath); 
        } catch { 
          const libResponse = await axios.get(artifact.url, { responseType: 'arraybuffer' }); 
          await fs.writeFile(libPath, Buffer.from(libResponse.data)); 
        } 
         
        downloadedLibs++; 
        const progress = Math.round((downloadedLibs / libraries.length) * 100); 
        mainWindow.webContents.send('library-progress', progress); 
      } 
    }
    
    // Download and extract native libraries
    mainWindow.webContents.send('download-status', 'Downloading native libraries...');
    await downloadNatives(versionData, versionId);
    
    // Asset'leri indir - YENİ EKLENEN!
    mainWindow.webContents.send('download-status', 'Downloading assets (this may take a while)...');
    const assetResult = await downloadAssets(versionData, versionId);
    
    if (!assetResult.success) {
      console.warn('Asset download had issues, but continuing...');
      mainWindow.webContents.send('download-status', 'Warning: Some assets may be missing');
    }
 
    return { success: true }; 
  } catch (error) { 
    console.error('Download error:', error); 
    return { success: false, error: error.message }; 
  } 
}); 

// Check Java version
function getJavaVersion(javaPath) {
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8' });
    const match = output.match(/version "(\d+)\.?(\d+)?/i) || output.match(/version (\d+)\.?(\d+)?/i);
    
    if (match) {
      const major = parseInt(match[1]);
      const minor = match[2] ? parseInt(match[2]) : 0;
      
      // Convert Java 1.8 format to 8
      if (major === 1 && minor === 8) {
        return 8;
      }
      return major;
    }
  } catch (e) {
    console.error(`Failed to get Java version for ${javaPath}:`, e.message);
  }
  return null;
}

// Determine required Java version based on Minecraft version
function getRequiredJavaVersion(minecraftVersion) {
  const versionMatch = minecraftVersion.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  
  if (!versionMatch) {
    return 17;
  }
  
  const major = parseInt(versionMatch[1]);
  const minor = parseInt(versionMatch[2]);
  
  if (major > 1 || (major === 1 && minor >= 17)) {
    return 17;
  }
  
  if (major === 1 && minor >= 12 && minor <= 16) {
    return 8;
  }
  
  if (major === 1 && minor <= 11) {
    return 8;
  }
  
  return 17;
}

// Find all Java installations
async function findAllJavaInstallations() {
  const javaInstallations = [];
  
  const possiblePaths = [
    'java',
    'C:\\Program Files\\Java\\jre1.8.0_401\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk1.8.0_401\\bin\\java.exe',
    'C:\\Program Files (x86)\\Java\\jre1.8.0_401\\bin\\java.exe',
    'C:\\Program Files (x86)\\Java\\jdk1.8.0_401\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-8.0.402.6-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Zulu\\zulu-8\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9.9-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.10.7-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Zulu\\zulu-17\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.1.12-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.2.13-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Zulu\\zulu-21\\bin\\java.exe',
    '/Library/Java/JavaVirtualMachines/jdk1.8.0_401.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/temurin-8.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
    '/usr/lib/jvm/java-8-openjdk/bin/java',
    '/usr/lib/jvm/java-8-openjdk-amd64/bin/java',
    '/usr/lib/jvm/java-17-openjdk/bin/java',
    '/usr/lib/jvm/java-17-openjdk-amd64/bin/java',
    '/usr/lib/jvm/java-21-openjdk/bin/java',
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/java'
  ];
  
  if (process.env.JAVA_HOME) {
    const javaHomePath = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    possiblePaths.unshift(javaHomePath);
  }
  
  for (const javaPath of possiblePaths) {
    try {
      execSync(`"${javaPath}" -version`, { stdio: 'pipe' });
      const version = getJavaVersion(javaPath);
      
      if (version) {
        javaInstallations.push({
          path: javaPath,
          version: version
        });
        console.log(`Found Java ${version} at: ${javaPath}`);
      }
    } catch (e) {
      continue;
    }
  }
  
  return javaInstallations;
}

// Select the best Java for the Minecraft version
async function selectJavaForVersion(minecraftVersion) {
  const requiredJava = getRequiredJavaVersion(minecraftVersion);
  const javaInstallations = await findAllJavaInstallations();
  
  if (javaInstallations.length === 0) {
    throw new Error('Java not found! Please install Java.');
  }
  
  console.log(`Minecraft ${minecraftVersion} requires Java ${requiredJava}`);
  
  let selectedJava = javaInstallations.find(j => j.version === requiredJava);
  
  if (!selectedJava) {
    if (requiredJava === 8) {
      selectedJava = javaInstallations.find(j => j.version >= 8);
    } else if (requiredJava === 17) {
      selectedJava = javaInstallations.find(j => j.version >= 17);
    }
  }
  
  if (!selectedJava) {
    selectedJava = javaInstallations.sort((a, b) => b.version - a.version)[0];
  }
  
  console.log(`Selected Java: ${selectedJava.version} (${selectedJava.path})`);
  
  return selectedJava.path;
}
 
// Oyunu başlat
ipcMain.handle('launch-game', async (event, versionId, username) => { 
  try { 
    const versionDir = path.join(VERSIONS_DIR, versionId); 
    const versionJsonPath = path.join(versionDir, `${versionId}.json`); 
    const versionJson = JSON.parse(await fs.readFile(versionJsonPath, 'utf8')); 
 
    // Natives directory
    const nativesDir = path.join(versionDir, 'natives');
    
    // Verify natives exist (with warning instead of error for modern versions)
    try {
      const nativeFiles = await fs.readdir(nativesDir);
      console.log(`Found ${nativeFiles.length} native files`);
      
      if (nativeFiles.length === 0) {
        console.warn('WARNING: No native files found - attempting to launch anyway');
        mainWindow.webContents.send('game-log', 'WARNING: No native libraries found\n');
      }
    } catch (e) {
      console.warn('Natives directory not found - may need re-download');
      mainWindow.webContents.send('game-log', 'WARNING: Natives not found, re-downloading...\n');
      
      // Try to re-download natives
      try {
        const versionData = versionJson;
        await downloadNatives(versionData, versionId);
      } catch (downloadErr) {
        console.error('Failed to download natives:', downloadErr);
      }
    }
 
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
 
    // Select appropriate Java
    const javaPath = await selectJavaForVersion(versionId);
    
    mainWindow.webContents.send('game-log', `Java selected: ${javaPath}\n`);
    mainWindow.webContents.send('game-log', `Natives directory: ${nativesDir}\n`);
    mainWindow.webContents.send('game-log', `Launching Minecraft ${versionId}...\n`);
 
    // Launch arguments 
    const args = [ 
      '-Xmx2G', 
      '-Xms512M', 
      `-Djava.library.path=${nativesDir}`, 
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

// List installed Java versions
ipcMain.handle('get-java-installations', async () => {
  try {
    const installations = await findAllJavaInstallations();
    return installations;
  } catch (error) {
    console.error('Java installations fetch error:', error);
    return [];
  }
});

// Versiyon sil
ipcMain.handle('delete-version', async (event, versionId) => {
  try {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    
    // Klasörün var olup olmadığını kontrol et
    try {
      await fs.access(versionDir);
    } catch {
      return { success: false, error: 'Version not found' };
    }
    
    // Versiyonu sil
    await fs.rm(versionDir, { recursive: true, force: true });
    console.log(`Deleted version: ${versionId}`);
    
    return { success: true };
  } catch (error) {
    console.error('Delete error:', error);
    return { success: false, error: error.message };
  }
});
