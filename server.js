const http = require('http');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { exec } = require('child_process');

const PORT = 3000;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Website to App Packager</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; background-color: #f4f4f4; }
                    h1 { color: #333; }
                    label { display: block; margin-bottom: 5px; }
                    input[type="url"] { width: 300px; padding: 8px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px; }
                    button { padding: 10px 15px; background-color: #5cb85c; color: white; border: none; border-radius: 4px; cursor: pointer; }
                    button:hover { background-color: #4cae4c; }
                    #status { margin-top: 15px; font-weight: bold; }
                    #downloadLink { display: none; margin-top: 10px; }
                </style>
            </head>
            <body>
                <h1>Website to Desktop App Packager</h1>
                <form id="packageForm">
                    <label for="urlInput">Enter Website URL:</label>
                    <input type="url" id="urlInput" name="url" required placeholder="https://example.com">
                    <button type="submit">Package App</button>
                </form>
                <div id="status"></div>
                <a id="downloadLink" href="#" download="packaged-app.zip">Download Packaged App (.zip)</a>

                <hr style="margin: 30px 0;">
                <h2>Download Server Code</h2>
                <p>Click the button below to download the Node.js server code (server.js and package.json) as a zip file.</p>
                <button onclick="downloadServerCode()">Download Server Code</button>


                <script>
                    const form = document.getElementById('packageForm');
                    const statusDiv = document.getElementById('status');
                    const downloadLink = document.getElementById('downloadLink');

                    form.addEventListener('submit', async (event) => {
                        event.preventDefault();
                        statusDiv.textContent = 'Packaging... Please wait.';
                        downloadLink.style.display = 'none';
                        const url = document.getElementById('urlInput').value;

                        try {
                            const response = await fetch('/package', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ url })
                            });

                            if (!response.ok) {
                                const errorData = await response.json();
                                throw new Error(errorData.message || 'Packaging failed.');
                            }

                            const data = await response.json();
                            statusDiv.textContent = 'Packaging successful!';
                            downloadLink.href = data.downloadUrl;
                            downloadLink.style.display = 'block';

                        } catch (error) {
                            statusDiv.textContent = \`Error: \${error.message}\`;
                            console.error('Packaging error:', error);
                        }
                    });

                    async function downloadServerCode() {
                         try {
                            const response = await fetch('/download-server');
                            if (!response.ok) {
                                throw new Error('Failed to download server code.');
                            }
                            const blob = await response.blob();
                            const url = window.URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.style.display = 'none';
                            a.href = url;
                            a.download = 'server-code.zip';
                            document.body.appendChild(a);
                            a.click();
                            window.URL.revokeObjectURL(url);
                            document.body.removeChild(a);
                        } catch (error) {
                            alert(\`Error downloading server code: \${error.message}\`);
                            console.error('Server code download error:', error);
                        }
                    }
                </script>
            </body>
            </html>
        `);
    } else if (req.method === 'POST' && req.url === '/package') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const { url } = JSON.parse(body);
                if (!url || !url.startsWith('http')) {
                    throw new Error('Invalid URL provided.');
                }

                const appId = `app_${Date.now()}`;
                const appDir = path.join(__dirname, 'apps', appId);
                const outputDir = path.join(__dirname, 'packaged', appId);
                const zipPath = path.join(__dirname, 'packaged', `${appId}.zip`);

                // 1. Create directories
                await fs.promises.mkdir(appDir, { recursive: true });
                await fs.promises.mkdir(outputDir, { recursive: true });
                await fs.promises.mkdir(path.join(__dirname, 'packaged'), { recursive: true });


                // 2. Create basic Electron app files
                const mainJsContent = `
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js') // Optional: if you need preload scripts
    }
  });

  mainWindow.loadURL('${url}'); // Load the target URL

  // Open the DevTools (optional)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
                `;
                await fs.promises.writeFile(path.join(appDir, 'main.js'), mainJsContent);

                // Basic package.json for the Electron app
                const packageJsonContent = JSON.stringify({
                    name: appId,
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
                await fs.promises.writeFile(path.join(appDir, 'preload.js'), '// Preload script (optional)');

                // 3. Install dependencies (electron)
                console.log(`Installing Electron for ${appId}...`);
                await new Promise((resolve, reject) => {
                    exec('npm install', { cwd: appDir }, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`npm install error: ${stderr}`);
                            return reject(new Error(`Failed to install Electron: ${stderr}`));
                        }
                        console.log(`npm install stdout: ${stdout}`);
                        resolve();
                    });
                });
                console.log(`Electron installed for ${appId}.`);


                // 4. Package the app using electron-packager
                // Note: electron-packager needs to be installed globally or as a dev dependency of *this* server project
                // For simplicity here, we assume it's globally installed (`npm install -g electron-packager`)
                // Or better: install it as a dev dependency of this server.js project: `npm install --save-dev electron-packager archiver`
                console.log(`Packaging app for ${appId}...`);
                const packageCmd = `npx electron-packager . ${appId} --platform=win32,linux --arch=x64 --out="${outputDir}" --overwrite`; // Specify platforms
                await new Promise((resolve, reject) => {
                    exec(packageCmd, { cwd: appDir }, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`electron-packager error: ${stderr}`);
                            return reject(new Error(`Failed to package app: ${stderr}`));
                        }
                        console.log(`electron-packager stdout: ${stdout}`);
                        resolve();
                    });
                });
                console.log(`App packaged for ${appId}.`);

                 // 5. Zip the packaged output directory
                console.log(`Zipping packaged app for ${appId}...`);
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });

                output.on('close', () => {
                    console.log(`Zip file created: ${zipPath} (${archive.pointer()} total bytes)`);
                    // Clean up intermediate directories (optional)
                    // fs.promises.rm(appDir, { recursive: true, force: true });
                    // fs.promises.rm(outputDir, { recursive: true, force: true });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ downloadUrl: `/download/${appId}.zip` }));
                });

                archive.on('warning', (err) => {
                    if (err.code === 'ENOENT') {
                        console.warn('Archiver warning:', err);
                    } else {
                        throw err; // Throw error on other warnings
                    }
                });

                archive.on('error', (err) => {
                    throw err; // Throw error if zipping fails
                });

                archive.pipe(output);
                // Add the entire contents of the output directory (containing win32 and linux builds)
                archive.directory(outputDir, false); // Add directory contents directly to zip root
                await archive.finalize();


            } catch (error) {
                console.error('Packaging error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: `Packaging failed: ${error.message}` }));
                 // Clean up potentially partially created directories on error
                if (typeof appId !== 'undefined') {
                    const appDir = path.join(__dirname, 'apps', appId);
                    const outputDir = path.join(__dirname, 'packaged', appId);
                    fs.promises.rm(appDir, { recursive: true, force: true }).catch(console.error);
                    fs.promises.rm(outputDir, { recursive: true, force: true }).catch(console.error);
                }
            }
        });

    } else if (req.method === 'GET' && req.url.startsWith('/download/')) {
        const filename = req.url.split('/download/')[1];
        const filePath = path.join(__dirname, 'packaged', filename);

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found.');
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': stats.size
            });
            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res);
             // Optional: Delete the zip file after download starts (or after a delay)
             readStream.on('close', () => {
                 console.log(`Download complete for ${filename}, deleting file.`);
                 fs.promises.unlink(filePath).catch(err => console.error(`Error deleting ${filePath}:`, err));
                 // Also clean the corresponding packaged folder (e.g., packaged/app_12345)
                 const folderName = path.basename(filename, '.zip');
                 const folderPath = path.join(__dirname, 'packaged', folderName);
                  fs.promises.rm(folderPath, { recursive: true, force: true })
                     .catch(err => console.error(`Error deleting folder ${folderPath}:`, err));
                 // Clean the source app folder too
                  const appSourcePath = path.join(__dirname, 'apps', folderName);
                   fs.promises.rm(appSourcePath, { recursive: true, force: true })
                     .catch(err => console.error(`Error deleting source folder ${appSourcePath}:`, err));
             });
        });
    } else if (req.method === 'GET' && req.url === '/download-server') {
        // Create a zip containing server.js and package.json
        const serverZipPath = path.join(__dirname, 'server-code.zip');
        const output = fs.createWriteStream(serverZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`Server code zip created: ${serverZipPath}`);
            fs.stat(serverZipPath, (err, stats) => {
                 if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error creating server code zip.');
                    return;
                 }
                 res.writeHead(200, {
                     'Content-Type': 'application/zip',
                     'Content-Disposition': 'attachment; filename="server-code.zip"',
                     'Content-Length': stats.size
                 });
                 const readStream = fs.createReadStream(serverZipPath);
                 readStream.pipe(res);
                 readStream.on('close', () => {
                      // Clean up the temporary server zip file
                      fs.promises.unlink(serverZipPath).catch(console.error);
                 });
            });
        });

        archive.on('error', (err) => {
            console.error('Error creating server code zip:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error creating server code zip.');
        });

        archive.pipe(output);
        archive.file(path.join(__dirname, 'server.js'), { name: 'server.js' });
        // Make sure package.json exists before adding it
        const packageJsonPath = path.join(__dirname, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            archive.file(packageJsonPath, { name: 'package.json' });
        } else {
             // Create a minimal package.json if it doesn't exist
             const minimalPackageJson = JSON.stringify({
                name: "website-packager-server",
                version: "1.0.0",
                description: "Node.js server to package websites into Electron apps",
                main: "server.js",
                scripts: {
                  "start": "node server.js"
                },
                dependencies: {
                  "archiver": "^6.0.0" // Or the version you installed
                },
                devDependencies: {
                  "electron-packager": "^17.0.0" // Or the version you installed
                }
              }, null, 2);
             archive.append(minimalPackageJson, { name: 'package.json' });
        }
        archive.finalize();

    }
     else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Ensure necessary directories exist on startup
Promise.all([
    fs.promises.mkdir(path.join(__dirname, 'apps'), { recursive: true }),
    fs.promises.mkdir(path.join(__dirname, 'packaged'), { recursive: true })
]).then(() => {
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log('Make sure you have Node.js and npm installed.');
        console.log('Install necessary dependencies for the server: npm install archiver electron-packager');
        console.log('Note: electron-packager might take time to download Electron binaries on first run.');
    });
}).catch(err => {
    console.error("Failed to create necessary directories:", err);
    process.exit(1);
});

// Graceful shutdown - try to clean up temp folders
process.on('SIGINT', () => {
    console.log("Shutting down server and cleaning up...");
    Promise.all([
        fs.promises.rm(path.join(__dirname, 'apps'), { recursive: true, force: true }),
        fs.promises.rm(path.join(__dirname, 'packaged'), { recursive: true, force: true })
    ]).then(() => {
        console.log("Cleanup complete.");
        process.exit(0);
    }).catch(err => {
        console.error("Error during cleanup:", err);
        process.exit(1);
    });
});

