const http = require('http');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { exec } = require('child_process');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APPS_DIR = path.join(__dirname, 'apps');
const PACKAGED_DIR = path.join(__dirname, 'packaged');
const TEMPLATES_DIR = path.join(__dirname, 'templates'); 
const ASSETS_DIR = path.join(__dirname, 'assets'); 

function replacePlaceholders(content, replacements) {
    let result = content;
    for (const key in replacements) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        result = result.replace(regex, replacements[key]);
    }
    return result;
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, 'utf8', (err, content) => {
            if (err) {
                const defaultIndexPath = path.join(PUBLIC_DIR, 'default-index.html');
                fs.readFile(defaultIndexPath, 'utf8', (defaultErr, defaultContent) => {
                    if (defaultErr) {
                        console.error("Error reading default-index.html:", defaultErr);
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Internal Server Error - Cannot find index.html or default-index.html');
                    } else {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(defaultContent);
                    }
                });
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
    }
    else if (req.method === 'POST' && req.url === '/package') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            let appId; 
            let appDir;
            let outputDir;
            let zipPath;
            try {
                const { url } = JSON.parse(body);
                if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
                   throw new Error('Invalid URL provided. Must start with http:// or https://');
                }

                appId = `app_${Date.now()}`; 
                appDir = path.join(APPS_DIR, appId);
                outputDir = path.join(PACKAGED_DIR, appId); 
                zipPath = path.join(PACKAGED_DIR, `${appId}.zip`); 

                await fs.promises.mkdir(appDir, { recursive: true });
                await fs.promises.mkdir(outputDir, { recursive: true });

                const mainJsTemplatePath = path.join(TEMPLATES_DIR, 'electron-main.js.template');
                const packageJsonTemplatePath = path.join(TEMPLATES_DIR, 'electron-package.json.template');

                const [mainJsTemplate, packageJsonTemplate] = await Promise.all([
                    fs.promises.readFile(mainJsTemplatePath, 'utf8'),
                    fs.promises.readFile(packageJsonTemplatePath, 'utf8')
                ]);

                const productName = `WebApp_${url.replace(/^(https?:\/\/)?(www\.)?/, '').split(/[:\/]/)[0]}`; 
                const electronVersion = "^28.0.0"; 

                const mainJsContent = replacePlaceholders(mainJsTemplate, { URL: url });
                const packageJsonContent = replacePlaceholders(packageJsonTemplate, {
                    APP_ID: appId,
                    PRODUCT_NAME: productName,
                    URL: url,
                    ELECTRON_VERSION: electronVersion
                });

                await Promise.all([
                    fs.promises.writeFile(path.join(appDir, 'main.js'), mainJsContent),
                    fs.promises.writeFile(path.join(appDir, 'package.json'), packageJsonContent)
                ]);

                const iconSourcePath = path.join(ASSETS_DIR, 'icon.ico'); 
                const iconDestPath = path.join(appDir, 'icon.ico');
                try {
                    if (fs.existsSync(iconSourcePath)) {
                        await fs.promises.copyFile(iconSourcePath, iconDestPath);
                        console.log(`[${appId}] Copied icon.ico`);
                    }
                } catch (iconError) {
                    console.warn(`[${appId}] Warning: Could not copy icon file: ${iconError.message}`);
                }

                console.log(`[${appId}] Installing Electron...`);
                await new Promise((resolve, reject) => {
                    exec('npm install --omit=dev', { cwd: appDir, timeout: 300000 }, (error, stdout, stderr) => { 
                        if (error) {
                            console.error(`[${appId}] npm install error: ${stderr}`);
                            let detail = stderr;
                            if (stderr.includes('EACCES')) detail = 'Permission error during npm install.';
                            else if (stderr.includes('ENOTFOUND') || stderr.includes('ETIMEDOUT')) detail = 'Network error during npm install.';
                            return reject(new Error(`Failed to install Electron: ${detail}`));
                        }
                        console.log(`[${appId}] npm install stdout: ${stdout}`);
                        resolve();
                    });
                });
                console.log(`[${appId}] Electron installed.`);

                console.log(`[${appId}] Packaging app...`);
                let iconArg = '';
                if (fs.existsSync(iconDestPath)) {
                    iconArg = `--icon="${iconDestPath}"`; 
                } else if (fs.existsSync(iconSourcePath)) { 
                    iconArg = `--icon="${iconSourcePath}"`;
                }
                const packageCmd = `npx electron-packager . "${productName}" --platform=win32,linux --arch=x64 --out="${outputDir}" --overwrite ${iconArg}`;
                await new Promise((resolve, reject) => {
                    exec(packageCmd, { cwd: appDir, timeout: 600000 }, (error, stdout, stderr) => { 
                        if (error) {
                            console.error(`[${appId}] electron-packager error: ${stderr}`);
                            let detail = stderr;
                            if (stderr.includes('Unable to download')) detail = 'Network error during Electron download for packaging.';
                            return reject(new Error(`Failed to package app: ${detail}`));
                        }
                        console.log(`[${appId}] electron-packager stdout: ${stdout}`);
                        resolve();
                    });
                });
                console.log(`[${appId}] App packaged.`);

                console.log(`[${appId}] Zipping packaged app...`);
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } }); 

                output.on('close', async () => {
                    const zipSizeBytes = archive.pointer();
                    console.log(`[${appId}] Zip file created: ${zipPath} (${(zipSizeBytes / (1024*1024)).toFixed(2)} MB)`);

                    try {
                        console.log(`[${appId}] Cleaning up source directory: ${appDir}`);
                        await fs.promises.rm(appDir, { recursive: true, force: true });
                        console.log(`[${appId}] Cleaning up intermediate build directory: ${outputDir}`);
                        await fs.promises.rm(outputDir, { recursive: true, force: true });
                    } catch (cleanupErr) {
                        console.warn(`[${appId}] Warning during cleanup: ${cleanupErr.message}`);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ downloadUrl: `/download/${path.basename(zipPath)}` })); 
                });

                archive.on('warning', (err) => {
                    if (err.code === 'ENOENT') console.warn(`[${appId}] Archiver warning: ${err.message}`);
                    else console.error(`[${appId}] Archiver warning: ${err}`);
                });

                archive.on('error', (err) => {
                    console.error(`[${appId}] Archiver error: ${err}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: `Zipping failed: ${err.message}` }));
                    }
                    if (appDir) fs.promises.rm(appDir, { recursive: true, force: true }).catch(console.error);
                    if (outputDir) fs.promises.rm(outputDir, { recursive: true, force: true }).catch(console.error);
                    if (zipPath) fs.promises.unlink(zipPath).catch(console.error);
                });

                archive.pipe(output);
                archive.directory(outputDir, false); 
                await archive.finalize(); 


            } catch (error) {
                console.error(`[${appId || 'N/A'}] Packaging error:`, error);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: `Packaging failed: ${error.message}` }));
                }
                if (appId) { 
                    if (appDir) fs.promises.rm(appDir, { recursive: true, force: true }).catch(err => console.error(`Cleanup error (appDir): ${err.message}`));
                    if (outputDir) fs.promises.rm(outputDir, { recursive: true, force: true }).catch(err => console.error(`Cleanup error (outputDir): ${err.message}`));
                    if (zipPath) fs.promises.unlink(zipPath).catch(err => { if (err.code !== 'ENOENT') console.error(`Cleanup error (zipPath): ${err.message}`);}); 
                }
            }
        });

    }
    else if (req.method === 'GET' && req.url.startsWith('/download/')) {
        const requestedFilename = req.url.split('/download/')[1];
        const safeFilename = path.basename(requestedFilename);
        if (safeFilename !== requestedFilename || !safeFilename.endsWith('.zip') || !safeFilename.startsWith('app_')) { 
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid filename.');
            return;
        }

        const filePath = path.join(PACKAGED_DIR, safeFilename);

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                console.error(`Download request for non-existent file: ${filePath}`, err ? err.message : 'Not a file');
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

            readStream.on('error', (streamErr) => {
                console.error(`Error reading file for download ${filePath}:`, streamErr);
                res.end(); 
            });

            readStream.pipe(res);

            const cleanupDownload = () => {
                console.log(`Initiating cleanup for ${safeFilename}.`);
                readStream.destroy(); 
                fs.promises.unlink(filePath)
                    .then(() => console.log(`Deleted ${filePath} after download attempt.`))
                    .catch(unlinkErr => {
                        if (unlinkErr.code !== 'ENOENT') { 
                            console.error(`Error deleting ${filePath}:`, unlinkErr);
                        }
                    });
            };

            req.on('close', () => {
                console.log(`Connection closed for ${safeFilename}.`);
                cleanupDownload();
            });

            res.on('finish', () => { 
                console.log(`Download finished for ${safeFilename}.`);
                cleanupDownload();
            });
        });
    }
    else if (req.method === 'GET' && req.url === '/download-server') {
        const tempServerZip = path.join(__dirname, `server-code_${Date.now()}.zip`); 
        const output = fs.createWriteStream(tempServerZip);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`Server code zip created temporarily: ${tempServerZip}`);
            fs.stat(tempServerZip, (err, stats) => {
                if (err) {
                    console.error("Error stating temporary server zip:", err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error creating server code zip.');
                    fs.promises.unlink(tempServerZip).catch(console.error); 
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': 'attachment; filename="server-code.zip"', 
                    'Content-Length': stats.size
                });
                const readStream = fs.createReadStream(tempServerZip);
                readStream.pipe(res);

                const cleanupServerZip = () => {
                    readStream.destroy();
                    fs.promises.unlink(tempServerZip).catch(err => {
                        if (err.code !== 'ENOENT') console.error(`Error deleting server temp zip: ${err.message}`);
                    });
                };
                res.on('finish', cleanupServerZip);
                readStream.on('error', (streamErr) => {
                    console.error(`Error streaming server code zip:`, streamErr);
                    cleanupServerZip(); 
                });
            });
        });

        archive.on('error', (err) => {
            console.error('Error creating server code zip:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error creating server code zip.');
            }
            fs.promises.unlink(tempServerZip).catch(console.error); 
        });

        archive.pipe(output);

        archive.file(path.join(__dirname, 'server.js'), { name: 'server.js' });
        archive.file(path.join(__dirname, 'package.json'), { name: 'package.json' });
        archive.directory(path.join(__dirname, 'public'), 'public');
        archive.directory(path.join(__dirname, 'templates'), 'templates');
        if (fs.existsSync(ASSETS_DIR)) {
            archive.directory(ASSETS_DIR, 'assets');
        } else {
            archive.append('', { name: 'assets/' });
        }

        archive.finalize();

    }
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

Promise.all([
    fs.promises.mkdir(PUBLIC_DIR, { recursive: true }),
    fs.promises.mkdir(APPS_DIR, { recursive: true }),
    fs.promises.mkdir(PACKAGED_DIR, { recursive: true }),
    fs.promises.mkdir(TEMPLATES_DIR, { recursive: true }),
    fs.promises.mkdir(ASSETS_DIR, { recursive: true }) 
]).then(() => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    const defaultIndexPath = path.join(PUBLIC_DIR, 'default-index.html');
    const mainTemplatePath = path.join(TEMPLATES_DIR, 'electron-main.js.template');
    const pkgTemplatePath = path.join(TEMPLATES_DIR, 'electron-package.json.template');

    const checks = [];

    if (!fs.existsSync(indexPath) && fs.existsSync(defaultIndexPath)) {
        console.log(`index.html not found in public directory, copying from default-index.html.`);
        checks.push(fs.promises.copyFile(defaultIndexPath, indexPath));
    } else if (!fs.existsSync(indexPath) && !fs.existsSync(defaultIndexPath)) {
        console.error("CRITICAL: public/index.html and public/default-index.html are both missing.");
    }

    if (!fs.existsSync(mainTemplatePath)) {
        console.log(`Creating default ${path.basename(mainTemplatePath)}.`);
        const defaultMainTemplate = `
const { app, BrowserWindow } = require('electron');
function createWindow () {
  const mainWindow = new BrowserWindow({ width: 800, height: 600 });
  mainWindow.loadURL('{{URL}}');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() });
`;
        checks.push(fs.promises.writeFile(mainTemplatePath, defaultMainTemplate.trim()));
    }

    if (!fs.existsSync(pkgTemplatePath)) {
        console.log(`Creating default ${path.basename(pkgTemplatePath)}.`);
        const defaultPkgTemplate = `
{
  "name": "{{APP_ID}}",
  "productName": "{{PRODUCT_NAME}}",
  "version": "1.0.0",
  "description": "App for {{URL}}",
  "main": "main.js",
  "scripts": { "start": "electron ." },
  "devDependencies": { "electron": "{{ELECTRON_VERSION}}" }
}
`;
        checks.push(fs.promises.writeFile(pkgTemplatePath, defaultPkgTemplate.trim()));
    }

    return Promise.all(checks);

}).then(() => {
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Access the packager at http://localhost:${PORT}`);
        console.log('Ensure Node.js and npm are installed.');
        console.log('Server dependencies (archiver, electron-packager) should be installed (`npm install`).');
        console.log('Packaging may take time, especially on first run or slow connections.');
    });
}).catch(err => {
    console.error("Failed to perform initial setup or start server:", err);
    process.exit(1);
});

async function cleanupAndExit() {
    console.log("\nShutting down server and cleaning up temporary files...");
    server.close(() => console.log("HTTP server closed.")); 

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

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});