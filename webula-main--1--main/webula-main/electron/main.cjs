const { app, BrowserWindow, shell, session } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEV_URL = process.env.ELECTRON_START_URL || 'http://localhost:4000';
const PREFERRED_PACKAGED_PORT = Number(process.env.ELECTRON_PACKAGED_PORT || 4000);

let mainWindow = null;
let localServer = null;
let localServerUrl = null;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const distDir = path.resolve(__dirname, '..', 'dist');

const isTrustedOrigin = (originOrUrl) => {
  if (!originOrUrl) return false;
  try {
    const parsed = new URL(originOrUrl);
    if (parsed.protocol === 'file:') return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

const allowFileSystemPermission = (permission, requestingOrigin, fallbackUrl = '') => {
  if (permission !== 'fileSystem') return false;
  return isTrustedOrigin(requestingOrigin) || isTrustedOrigin(fallbackUrl);
};

const sendFile = (res, filePath) => {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Failed to read file.');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
};

const createStaticServer = () => http.createServer((req, res) => {
  const requestUrl = req.url || '/';
  const pathname = requestUrl.split('?')[0] || '/';
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const requestedFile = path.join(distDir, safePath);

  fs.stat(requestedFile, (err, stats) => {
    if (!err && stats.isFile()) {
      sendFile(res, requestedFile);
      return;
    }

    sendFile(res, path.join(distDir, 'index.html'));
  });
});

const listenServer = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off('listening', onListening);
    reject(error);
  };

  const onListening = () => {
    server.off('error', onError);
    resolve();
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
});

const startStaticServer = async () => {
  const preferredPort = Number.isFinite(PREFERRED_PACKAGED_PORT) && PREFERRED_PACKAGED_PORT > 0
    ? PREFERRED_PACKAGED_PORT
    : 4000;
  const host = 'localhost';
  let server = createStaticServer();

  try {
    await listenServer(server, preferredPort, host);
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      server = createStaticServer();
      await listenServer(server, 0, host);
    } else {
      throw error;
    }
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to start local server.');
  }

  localServer = server;
  localServerUrl = `http://${host}:${address.port}`;
  return localServerUrl;
};

const configurePermissions = () => {
  const ses = session.defaultSession;
  if (!ses) return;

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return allowFileSystemPermission(permission, requestingOrigin);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details?.requestingOrigin || '';
    const fallbackUrl = webContents?.getURL?.() || '';
    callback(allowFileSystemPermission(permission, requestingOrigin, fallbackUrl));
  });
};

app.commandLine.appendSwitch('enable-features', 'FileSystemAccessAPI');

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'Webula',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (app.isPackaged) {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      throw new Error(`Missing build output at ${distDir}. Run "npm run build" before packaging.`);
    }
    const url = await startStaticServer();
    await mainWindow.loadURL(url);
  } else {
    await mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.whenReady().then(() => {
  configurePermissions();
  return createWindow();
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      console.error(error);
      app.quit();
    });
  }
});

app.on('before-quit', () => {
  if (localServer) {
    localServer.close();
    localServer = null;
    localServerUrl = null;
  }
});
