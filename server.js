const http = require('http');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { exec } = require('child_process');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APPS_DIR = path.join(__dirname, 'apps');
const PACKAGED_DIR = path.join(__dirname, 'packaged');

const server = http.createServer((req, res) => {
    // Serve static index.html
    if (req.method === 'GET' && req.url === '/') {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, 'utf8', (err, content) => {
            if (err) {
                console.error("Error reading index.html:", err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
    }
    // Handle packaging request
    else if (req.method === 'POST' && req.url === '/package') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            let appId; // Declare appId here to be accessible in catch block
            try {
                const { url } = JSON.parse(body);
                if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
                   throw new Error('Invalid URL provided. Must start with http:// or https://');
                }

                appId = `app_${Date.now()}`; // Assign value here
                const appDir = path.join(APPS_DIR, appId);
                const outputDir = path.join(PACKAGED_DIR, appId); // Directory for unpacked builds
                const zipPath = path.join(PACKAGED_DIR, `${appId}.zip`); // Final zip file path

                // 1. Create directories (already ensured on startup, but good practice)
                await fs.promises.mkdir(appDir, { recursive: true });
                await fs.promises.mkdir(outputDir, { recursive: true });


                // 2. Create basic Electron app files
                const mainJsContent = `
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 1024, // Slightly larger default size
    height: 768,
    webPreferences: {
      // preload: path.join(__dirname, 'preload.js') // Optional: if you need preload scripts
      // Security consideration: It's generally safer to keep nodeIntegration false
      // and rely on contextBridge in a preload script if Node.js access is needed in the renderer.
      // nodeIntegration: false,
      // contextIsolation: true,
    },
    // Set an icon (optional) - place an icon.png in the appDir
    // icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadURL('${url}'); // Load the target URL

  // Improve UX: Maximize window on start (optional)
  // mainWindow.maximize();

  // Open the DevTools (optional)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
                `;
                await fs.promises.writeFile(path.join(appDir, 'main.js'), mainJsContent);

                // Basic package.json for the Electron app
                const packageJsonContent = JSON.stringify({
                    name: appId,
                    productName: `WebApp_${url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0]}`, // Better product name
                    version: '1.0.0',
                    description: `Desktop app for ${url}`,
                    main: 'main.js',
                    scripts: {
                        start: 'electron .'
                        // Add build scripts later if using electron-builder/packager directly
                    },
                    devDependencies: {
                        electron: "^28.0.0" // Use a recent stable version
                    }
                }, null, 2);
                await fs.promises.writeFile(path.join(appDir, 'package.json'), packageJsonContent);

                // Optional: Create empty preload.js
                // await fs.promises.writeFile(path.join(appDir, 'preload.js'), '// Preload script (optional)');

                // 3. Install dependencies (electron)
                console.log(`[${appId}] Installing Electron...`);
                await new Promise((resolve, reject) => {
                    // Use npm ci for potentially faster and more reliable installs if package-lock.json exists (npm install generates it)
                    exec('npm install', { cwd: appDir, timeout: 300000 }, (error, stdout, stderr) => { // Increased timeout
                        if (error) {
                            console.error(`[${appId}] npm install error: ${stderr}`);
                            // Try to provide more specific feedback
                            let detail = stderr;
                            if (stderr.includes('EACCES')) {
                                detail = 'Permission error during npm install. Check file permissions.';
                            } else if (stderr.includes('ENOTFOUND') || stderr.includes('ETIMEDOUT')) {
                                detail = 'Network error during npm install. Check internet connection and proxy settings.';
                            }
                            return reject(new Error(`Failed to install Electron: ${detail}`));
                        }
                        console.log(`[${appId}] npm install stdout: ${stdout}`);
                        resolve();
                    });
                });
                console.log(`[${appId}] Electron installed.`);


                // 4. Package the app using electron-packager
                console.log(`[${appId}] Packaging app...`);
                // Platform options: win32, linux, darwin (macOS)
                // Arch options: x64, arm64, ia32 etc.
                const packageCmd = `npx electron-packager . --platform=win32,linux --arch=x64 --out="${outputDir}" --overwrite --icon="${path.join(__dirname, 'assets', 'icon.ico')}"`; // Reference an icon if available
                // Note: Add --icon for macOS builds: --icon="path/to/icon.icns" if building for darwin
                await new Promise((resolve, reject) => {
                    exec(packageCmd, { cwd: appDir, timeout: 600000 }, (error, stdout, stderr) => { // Increased timeout
                        if (error) {
                            console.error(`[${appId}] electron-packager error: ${stderr}`);
                            let detail = stderr;
                             if (stderr.includes('Unable to download')) {
                                detail = 'Network error during Electron download for packaging. Check internet connection.';
                            }
                            return reject(new Error(`Failed to package app: ${detail}`));
                        }
                        console.log(`[${appId}] electron-packager stdout: ${stdout}`);
                        resolve();
                    });
                });
                console.log(`[${appId}] App packaged.`);

                 // 5. Zip the packaged output directory
                console.log(`[${appId}] Zipping packaged app...`);
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } }); // Optimal compression

                output.on('close', async () => {
                    const zipSizeBytes = archive.pointer();
                    console.log(`[${appId}] Zip file created: ${zipPath} (${(zipSizeBytes / (1024*1024)).toFixed(2)} MB)`);

                    // Clean up intermediate directories *after* zip is confirmed closed
                    try {
                         console.log(`[${appId}] Cleaning up source directory: ${appDir}`);
                         await fs.promises.rm(appDir, { recursive: true, force: true });
                         console.log(`[${appId}] Cleaning up intermediate build directory: ${outputDir}`);
                         await fs.promises.rm(outputDir, { recursive: true, force: true });
                     } catch (cleanupErr) {
                         console.warn(`[${appId}] Warning during cleanup: ${cleanupErr.message}`);
                     }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ downloadUrl: `/download/${path.basename(zipPath)}` })); // Use path.basename for safety
                });

                archive.on('warning', (err) => {
                    if (err.code === 'ENOENT') {
                        console.warn(`[${appId}] Archiver warning: ${err.message}`); // Log file not found warnings
                    } else {
                         console.error(`[${appId}] Archiver warning: ${err}`);
                        // Consider if other warnings should reject the promise
                    }
                });

                archive.on('error', (err) => {
                     console.error(`[${appId}] Archiver error: ${err}`);
                    // Ensure response isn't sent twice if headers already sent
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: `Zipping failed: ${err.message}` }));
                    }
                     // Attempt cleanup even on zip error
                     fs.promises.rm(appDir, { recursive: true, force: true }).catch(console.error);
                     fs.promises.rm(outputDir, { recursive: true, force: true }).catch(console.error);
                     fs.promises.unlink(zipPath).catch(console.error); // Delete potentially incomplete zip
                });

                archive.pipe(output);
                // Add the entire contents of the output directory (containing platform-specific builds)
                archive.directory(outputDir, false); // Add directory contents directly to zip root
                await archive.finalize(); // Finalize the archive


            } catch (error) {
                console.error(`[${appId || 'N/A'}] Packaging error:`, error);
                 if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: `Packaging failed: ${error.message}` }));
                 }
                 // Clean up potentially partially created directories on error
                if (appId) { // Use the appId captured earlier
                    const appDir = path.join(APPS_DIR, appId);
                    const outputDir = path.join(PACKAGED_DIR, appId);
                    const zipPath = path.join(PACKAGED_DIR, `${appId}.zip`);
                    fs.promises.rm(appDir, { recursive: true, force: true }).catch(err => console.error(`Cleanup error (appDir): ${err.message}`));
                    fs.promises.rm(outputDir, { recursive: true, force: true }).catch(err => console.error(`Cleanup error (outputDir): ${err.message}`));
                    fs.promises.unlink(zipPath).catch(err => { if (err.code !== 'ENOENT') console.error(`Cleanup error (zipPath): ${err.message}`);}); // Ignore if zip doesn't exist
                }
            }
        });

    }
    // Handle packaged app download request
    else if (req.method === 'GET' && req.url.startsWith('/download/')) {
        const requestedFilename = req.url.split('/download/')[1];
        // Basic sanitization: prevent directory traversal
        const safeFilename = path.basename(requestedFilename);
        if (safeFilename !== requestedFilename || !safeFilename.endsWith('.zip')) {
             res.writeHead(400, { 'Content-Type': 'text/plain' });
             res.end('Invalid filename.');
             return;
        }

        const filePath = path.join(PACKAGED_DIR, safeFilename);

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                console.error(`Download request for non-existent file: ${filePath}`, err);
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found or is not accessible.');
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${safeFilename}"`,
                'Content-Length': stats.size
            });
            const readStream = fs.createReadStream(filePath);

             // Error handling for the stream
             readStream.on('error', (streamErr) => {
                 console.error(`Error reading file for download ${filePath}:`, streamErr);
                 // Can't change headers now, but can end the response abruptly.
                 res.end();
             });

            readStream.pipe(res);

             // Clean up the zip file after the download finishes or connection closes
             req.on('close', () => { // Handle client closing connection early
                  console.log(`Connection closed for ${safeFilename}. Cleaning up.`);
                  fs.promises.unlink(filePath)
                      .then(() => console.log(`Deleted ${filePath} after client disconnect.`))
                      .catch(unlinkErr => console.error(`Error deleting ${filePath} after disconnect:`, unlinkErr));
             });

             readStream.on('close', () => {
                 console.log(`Download stream closed for ${safeFilename}. Initiating cleanup.`);
                 // Ensure file is deleted after stream finishes
                 fs.promises.unlink(filePath)
                     .then(() => console.log(`Deleted ${filePath} after successful download.`))
                     .catch(unlinkErr => console.error(`Error deleting ${filePath} after download:`, unlinkErr));
                // Note: Intermediate build folders (e.g., packaged/app_12345) were already deleted after zipping.
                // The source app folder (e.g., apps/app_12345) was also deleted after zipping.
             });
        });
    }
    // Handle server code download request
    else if (req.method === 'GET' && req.url === '/download-server') {
        // Create a temporary zip containing server.js and package.json
        const tempServerZip = path.join(__dirname, `server-code_${Date.now()}.zip`); // Use temp name
        const output = fs.createWriteStream(tempServerZip);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`Server code zip created temporarily: ${tempServerZip}`);
            fs.stat(tempServerZip, (err, stats) => {
                 if (err) {
                    console.error("Error stating temporary server zip:", err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error creating server code zip.');
                    fs.promises.unlink(tempServerZip).catch(console.error); // Clean up temp file on error
                    return;
                 }
                 res.writeHead(200, {
                     'Content-Type': 'application/zip',
                     'Content-Disposition': 'attachment; filename="server-code.zip"', // User-friendly name
                     'Content-Length': stats.size
                 });
                 const readStream = fs.createReadStream(tempServerZip);
                 readStream.pipe(res);
                 readStream.on('close', () => {
                      // Clean up the temporary server zip file after download
                      fs.promises.unlink(tempServerZip).catch(console.error);
                 });
                 readStream.on('error', (streamErr) => {
                     console.error(`Error streaming server code zip:`, streamErr);
                     fs.promises.unlink(tempServerZip).catch(console.error); // Clean up on stream error
                 });
            });
        });

        archive.on('error', (err) => {
            console.error('Error creating server code zip:', err);
             if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error creating server code zip.');
             }
             fs.promises.unlink(tempServerZip).catch(console.error); // Clean up temp file on archive error
        });

        archive.pipe(output);
        archive.file(path.join(__dirname, 'server.js'), { name: 'server.js' });
        const packageJsonPath = path.join(__dirname, 'package.json');

        // Add package.json, create minimal if not found
        if (fs.existsSync(packageJsonPath)) {
            archive.file(packageJsonPath, { name: 'package.json' });
        } else {
             console.warn("package.json not found, creating a minimal one for the download.");
             const minimalPackageJson = JSON.stringify({
                name: "website-packager-server",
                version: "1.0.0",
                description: "Node.js server to package websites into Electron apps",
                main: "server.js",
                scripts: {
                  "start": "node server.js",
                  "install-deps": "npm install" // Added install script hint
                },
                dependencies: {
                  "archiver": "^6.0.0" // Match installed or latest
                },
                devDependencies: {
                  "electron-packager": "^17.0.0" // Match installed or latest
                },
                 engines: {
                    "node": ">=16.0.0" // Good practice
                  }
              }, null, 2);
             archive.append(minimalPackageJson, { name: 'package.json' });
        }
        archive.finalize();

    }
    // Handle other requests
     else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Ensure necessary directories exist on startup
Promise.all([
    fs.promises.mkdir(PUBLIC_DIR, { recursive: true }),
    fs.promises.mkdir(APPS_DIR, { recursive: true }),
    fs.promises.mkdir(PACKAGED_DIR, { recursive: true })
]).then(() => {
    // Check if index.html exists, create a basic one if not
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.log("index.html not found in public directory, creating a default one.");
        const defaultIndexContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Website to App Packager</title>
    <style>
        body { font-family: sans-serif; padding: 20px; background-color: #f4f4f4; color: #333; max-width: 800px; margin: 20px auto; }
        h1, h2 { color: #333; border-bottom: 1px solid #ccc; padding-bottom: 5px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input[type="url"] { width: 95%; max-width: 400px; padding: 10px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 4px; font-size: 1em; }
        button { padding: 12px 20px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1em; transition: background-color 0.2s; }
        button:hover { background-color: #218838; }
        button:disabled { background-color: #aaa; cursor: not-allowed; }
        #status { margin-top: 20px; font-weight: bold; padding: 10px; border-radius: 4px; }
        #status.success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        #status.error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        #status.info { background-color: #e2e3e5; color: #383d41; border: 1px solid #d6d8db; }
        #downloadLink { display: none; margin-top: 15px; padding: 10px 15px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px; transition: background-color 0.2s; }
        #downloadLink:hover { background-color: #0056b3; }
        .section { background-color: #fff; padding: 20px; margin-top: 20px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    </style>
</head>
<body>
    <h1>Website to Desktop App Packager</h1>

    <div class="section">
        <h2>Create App</h2>
        <form id="packageForm">
            <label for="urlInput">Enter Website URL:</label>
            <input type="url" id="urlInput" name="url" required placeholder="https://example.com">
            <button type="submit" id="packageButton">Package App</button>
        </form>
        <div id="status">Enter a URL and click "Package App".</div>
        <a id="downloadLink" href="#" download>Download Packaged App (.zip)</a>
    </div>

    <div class="section">
        <h2>Download Server Code</h2>
        <p>Click the button below to download the Node.js server code (server.js and package.json) needed to run this packager yourself.</p>
        <button onclick="downloadServerCode(event)">Download Server Code</button> 
    </div>

    <script>
        const form = document.getElementById('packageForm');
        const statusDiv = document.getElementById('status');
        const downloadLink = document.getElementById('downloadLink');
        const urlInput = document.getElementById('urlInput');
        const packageButton = document.getElementById('packageButton');

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            statusDiv.textContent = 'Packaging starting... This may take several minutes (especially the first time). Please wait.';
            statusDiv.className = 'info'; 
            downloadLink.style.display = 'none';
            downloadLink.href = '#'; 
            packageButton.disabled = true; 
            urlInput.disabled = true;

            const url = urlInput.value;

            try {
                const response = await fetch('/package', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });

                const responseBody = await response.text();
                let data;
                try {
                    data = JSON.parse(responseBody);
                } catch (parseError) {
                    if (!response.ok) {
                         throw new Error(responseBody || `Server responded with status ${response.status}`);
                    } else {
                        throw new Error("Received non-JSON success response from server.");
                    }
                }

                if (!response.ok) {
                    throw new Error(data.message || `Packaging failed with status ${response.status}.`);
                }


                statusDiv.textContent = 'Packaging successful! Your download should appear below.';
                statusDiv.className = 'success';
                downloadLink.href = data.downloadUrl;
                const filename = data.downloadUrl.split('/').pop() || 'packaged-app.zip';
                downloadLink.download = filename;
                downloadLink.style.display = 'inline-block'; 

            } catch (error) {
                console.error('Packaging error:', error);
                statusDiv.textContent = `Error: ${error.message}`;
                statusDiv.className = 'error';
            } finally {
                 packageButton.disabled = false; 
                 urlInput.disabled = false;
            }
        });

        async function downloadServerCode(event) { 
             const button = event.target;
             button.disabled = true; 
             const originalText = button.textContent; 
             button.textContent = 'Downloading...';
             try {
                const response = await fetch('/download-server');
                if (!response.ok) {
                    throw new Error(`Failed to download server code (${response.status} ${response.statusText})`);
                }
                const blob = await response.blob();
                const downloadUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = downloadUrl;
                const disposition = response.headers.get('content-disposition');
                let filename = 'server-code.zip';
                if (disposition && disposition.indexOf('attachment') !== -1) {
                    const filenameRegex = /filename[^;=\\n]*=((['"]).*?\\2|[^;\\n]*)/;
                    const matches = filenameRegex.exec(disposition);
                    if (matches != null && matches[1]) {
                      filename = matches[1].replace(/['"]/g, '');
                    }
                }
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(downloadUrl);
                document.body.removeChild(a);
            } catch (error) {
                console.error('Server code download error:', error);
                alert(`Error downloading server code: ${error.message}`);
            } finally {
                 button.disabled = false; 
                 button.textContent = originalText; 
            }
        }
    </script>
</body>
</html>
`;
        fs.writeFileSync(indexPath, defaultIndexContent);
        console.log(`Created default ${indexPath}`);
    }

    // Start the server after setup
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Access the packager at http://localhost:${PORT}`);
        console.log('Ensure Node.js and npm are installed.');
        console.log('Server dependencies (archiver, electron-packager) should be installed (`npm install`).');
        console.log('Packaging may take time, especially on first run or slow connections.');
    });
}).catch(err => {
    console.error("Failed to create necessary directories or start server:", err);
    process.exit(1);
});

// Graceful shutdown - try to clean up temp folders
async function cleanupAndExit() {
    console.log("\nShutting down server and cleaning up temporary files...");
    try {
        const cleanDir = async (dir) => {
            try {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                await Promise.all(entries.map(entry => {
                    const fullPath = path.join(dir, entry.name);
                    return fs.promises.rm(fullPath, { recursive: true, force: true });
                }));
                console.log(`Cleaned contents of ${dir}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { 
                    console.error(`Error cleaning ${dir}:`, err);
                }
            }
        };

        await Promise.all([
            cleanDir(APPS_DIR),
            cleanDir(PACKAGED_DIR),
            fs.promises.readdir(__dirname).then(files =>
                Promise.all(files
                    .filter(f => f.startsWith('server-code_') && f.endsWith('.zip'))
                    .map(f => fs.promises.unlink(path.join(__dirname, f)).catch(console.error))
                )
            )
        ]);
        console.log("Cleanup finished.");
        process.exit(0);
    } catch (err) {
        console.error("Error during cleanup:", err);
        process.exit(1);
    }
}

process.on('SIGINT', cleanupAndExit); 
process.on('SIGTERM', cleanupAndExit); 

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Consider exiting or implementing more robust error handling/reporting
  // process.exit(1); 
});