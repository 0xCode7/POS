import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = currentDirectory;
const backendPort = Number(process.env.POS_ELECTRON_PORT ?? 0);
const configuredUserDataDirectory = process.env.POS_ELECTRON_USER_DATA_DIR;
if (configuredUserDataDirectory) {
  if (!path.isAbsolute(configuredUserDataDirectory))
    throw new Error('POS_ELECTRON_USER_DATA_DIR must be an absolute path.');
  app.setPath('userData', path.normalize(configuredUserDataDirectory));
}
let backend: ChildProcess | undefined;
let bridge: net.Server | undefined;
let bridgeSocket = '';
let bridgeSecret = '';
let mainWindow: BrowserWindow | undefined;
let isQuitting = false;
let activePort: number | undefined;

type BridgeRequest = {
  secret?: string;
  action?: 'pick-directory' | 'open-directory';
  directory?: string;
};

function iconPath() {
  return process.platform === 'win32'
    ? path.join(runtimeDirectory, 'icons', 'icon.ico')
    : path.join(runtimeDirectory, 'icons', '512x512.png');
}

function paths() {
  const userData = app.getPath('userData');
  return {
    userData,
    data: path.join(userData, 'data'),
    logs: path.join(userData, 'logs'),
    server: path.join(runtimeDirectory, 'server', 'index.js'),
    client: path.join(runtimeDirectory, 'client'),
    migrations: path.join(runtimeDirectory, 'drizzle'),
    supervisor: path.join(
      runtimeDirectory,
      'server',
      'maintenance',
      'supervisor-cli.js',
    ),
  };
}

function desktopLog(event: string, message: string) {
  try {
    const { logs } = paths();
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(logs, 'desktop.log'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: event.slice(0, 80),
        message: message.replace(/[\r\n\t]/g, ' ').slice(0, 500),
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics must never prevent local sales operations.
  }
}

function allocatePort() {
  if (Number.isInteger(backendPort) && backendPort > 0 && backendPort < 65_536)
    return Promise.resolve(backendPort);
  return new Promise<number>((resolve, reject) => {
    const candidate = net.createServer();
    candidate.unref();
    candidate.once('error', reject);
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address();
      candidate.close(() => {
        if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('تعذر اختيار منفذ محلي للتطبيق.'));
      });
    });
  });
}

function desktopBridgePath(dataDirectory: string) {
  const id = createHash('sha256')
    .update(dataDirectory)
    .digest('hex')
    .slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\restaurant-pos-electron-${id}`
    : path.join(dataDirectory, '.restaurant-pos-electron.sock');
}

async function startDesktopBridge() {
  const { data } = paths();
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  bridgeSocket = desktopBridgePath(data);
  bridgeSecret = randomBytes(32).toString('base64url');
  if (process.platform !== 'win32') fs.rmSync(bridgeSocket, { force: true });
  bridge = net.createServer((connection) => {
    let raw = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => (raw += chunk));
    connection.on('end', () => void handleBridgeRequest(connection, raw));
  });
  await new Promise<void>((resolve, reject) => {
    bridge?.once('error', reject);
    bridge?.listen(bridgeSocket, resolve);
  });
}

async function handleBridgeRequest(connection: net.Socket, raw: string) {
  try {
    const request = JSON.parse(raw) as BridgeRequest;
    if (request.secret !== bridgeSecret)
      throw new Error('طلب سطح المكتب غير مصرح به.');
    if (request.action === 'pick-directory') {
      const result = await dialog.showOpenDialog({
        title: 'اختيار مجلد النسخ الاحتياطية',
        properties: ['openDirectory', 'createDirectory'],
      });
      return bridgeReply(connection, true, {
        directory: result.canceled ? undefined : result.filePaths[0],
      });
    }
    if (request.action === 'open-directory' && request.directory) {
      const result = await shell.openPath(request.directory);
      if (result) throw new Error('تعذر فتح مجلد النسخ المحلي.');
      return bridgeReply(connection, true, {});
    }
    throw new Error('طلب سطح المكتب غير صالح.');
  } catch (error) {
    bridgeReply(
      connection,
      false,
      undefined,
      error instanceof Error ? error.message : 'فشل طلب سطح المكتب.',
    );
  }
}

function bridgeReply(
  connection: net.Socket,
  ok: boolean,
  result?: unknown,
  error?: string,
) {
  connection.end(`${JSON.stringify({ ok, result, error })}\n`);
}

async function startBackend(port: number) {
  const runtime = paths();
  if (!fs.existsSync(runtime.supervisor))
    throw new Error(
      'ملفات تشغيل الخدمة المحلية غير مكتملة. أعد تثبيت التطبيق.',
    );
  fs.mkdirSync(runtime.logs, { recursive: true, mode: 0o700 });
  backend = spawn(process.execPath, [runtime.supervisor], {
    cwd: runtimeDirectory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      POS_DATA_DIR: runtime.data,
      POS_CLIENT_DIR: runtime.client,
      POS_MIGRATIONS_DIR: runtime.migrations,
      POS_LOG_DIR: runtime.logs,
      POS_ELECTRON_BRIDGE_SOCKET: bridgeSocket,
      POS_ELECTRON_BRIDGE_SECRET: bridgeSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const writeLog = (name: string) => (chunk: Buffer) =>
    fs.appendFileSync(path.join(runtime.logs, name), chunk);
  backend.stdout?.on('data', writeLog('backend.stdout.log'));
  backend.stderr?.on('data', writeLog('backend.stderr.log'));
  desktopLog(
    'supervisor_started',
    `pid=${backend.pid ?? 'unknown'} port=${port}`,
  );
  backend.once('exit', (code, signal) => {
    desktopLog(
      'supervisor_exited',
      `code=${code ?? 'null'} signal=${signal ?? 'none'}`,
    );
    backend = undefined;
  });
}

async function waitForHealth(port: number) {
  const deadline = Date.now() + 30_000;
  return new Promise<void>((resolve, reject) => {
    const probe = () => {
      const request = http.get(
        `http://127.0.0.1:${port}/api/health`,
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            desktopLog('health_ok', `port=${port}`);
            resolve();
          } else retry();
        },
      );
      request.once('error', (error) => {
        desktopLog('health_error', error.message);
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline)
        reject(new Error('تعذر تشغيل الخدمة المحلية خلال المهلة المحددة.'));
      else setTimeout(probe, 250);
    };
    probe();
  });
}

async function waitForServiceRecovery(port: number) {
  const deadline = Date.now() + 60_000;
  let serviceStopped = false;
  return new Promise<void>((resolve, reject) => {
    const probe = () => {
      const request = http.get(
        `http://127.0.0.1:${port}/api/health`,
        (response) => {
          response.resume();
          if (serviceStopped && response.statusCode === 200) return resolve();
          scheduleProbe();
        },
      );
      request.once('error', () => {
        serviceStopped = true;
        scheduleProbe();
      });
    };
    const scheduleProbe = () => {
      if (Date.now() >= deadline)
        reject(new Error('تعذر تأكيد إعادة تشغيل الخدمة بعد الاستعادة.'));
      else setTimeout(probe, 250);
    };
    probe();
  });
}

function createWindow(origin: string) {
  const windowState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    icon: iconPath(),
    title: 'مطعم أفندينا',
    webPreferences: {
      preload: path.join(runtimeDirectory, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.maximize();
  if (!windowState.maximized) mainWindow.unmaximize();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.webRequest.onCompleted((details) => {
    const url = new URL(details.url);
    if (url.origin === origin && url.pathname.startsWith('/api/'))
      desktopLog(
        'api_response',
        `${url.pathname} status=${details.statusCode}`,
      );
  });
  mainWindow.webContents.session.webRequest.onErrorOccurred((details) => {
    const url = new URL(details.url);
    if (url.origin === origin && url.pathname.startsWith('/api/'))
      desktopLog('api_network_error', `${url.pathname} error=${details.error}`);
  });
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, code, description, url) => {
      desktopLog('renderer_load_failed', `code=${code} ${description} ${url}`);
    },
  );
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => saveWindowState(mainWindow));
  void mainWindow.loadURL(origin);
}

function loadWindowState() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(paths().userData, 'window-state.json'), 'utf8'),
    ) as { width?: number; height?: number; maximized?: boolean };
    return {
      width: Math.max(1024, raw.width ?? 1366),
      height: Math.max(680, raw.height ?? 768),
      maximized: Boolean(raw.maximized),
    };
  } catch {
    return { width: 1366, height: 768, maximized: true };
  }
}

function saveWindowState(window: BrowserWindow | undefined) {
  if (!window) return;
  const bounds = window.getBounds();
  fs.mkdirSync(paths().userData, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(paths().userData, 'window-state.json'),
    JSON.stringify({
      width: bounds.width,
      height: bounds.height,
      maximized: window.isMaximized(),
    }),
  );
}

function setupIpc() {
  ipcMain.on('diagnostics:api', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') return;
    const value = input as { path?: unknown; kind?: unknown; status?: unknown };
    if (
      typeof value.path !== 'string' ||
      !value.path.startsWith('/api/') ||
      !['request', 'response', 'network-error'].includes(String(value.kind))
    )
      return;
    const status = Number.isInteger(value.status)
      ? ` status=${value.status}`
      : '';
    desktopLog(`renderer_api_${value.kind}`, `${value.path}${status}`);
  });
  ipcMain.handle('receipt:print', async () => {
    if (!mainWindow) return { ok: false, error: 'نافذة التطبيق غير متاحة.' };
    return new Promise((resolve) =>
      mainWindow?.webContents.print(
        { silent: false, printBackground: true },
        (success, reason) =>
          resolve(
            success
              ? { ok: true }
              : { ok: false, error: reason || 'تعذر فتح نافذة الطباعة.' },
          ),
      ),
    );
  });
  ipcMain.handle('app:open-logs', async () => {
    const error = await shell.openPath(paths().logs);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('app:restart', async () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });
  ipcMain.handle('app:wait-for-service-recovery', async () => {
    if (!activePort) return { ok: false, error: 'الخدمة المحلية غير متاحة.' };
    try {
      await waitForServiceRecovery(activePort);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'تعذر إعادة الاتصال بالخدمة.',
      };
    }
  });
}

function errorWindow(error: unknown) {
  const message = error instanceof Error ? error.message : 'خطأ غير معروف.';
  const action = dialog.showMessageBoxSync({
    type: 'error',
    title: 'تعذر تشغيل مطعم أفندينا',
    message: 'لم يتم تشغيل الخدمة المحلية.',
    detail: message,
    buttons: ['إعادة المحاولة', 'فتح السجل', 'إغلاق'],
  });
  if (action === 0) void launch();
  else if (action === 1) void shell.openPath(paths().logs);
  else app.quit();
}

async function launch() {
  try {
    desktopLog('desktop_starting', `version=${app.getVersion()}`);
    const port = await allocatePort();
    await startDesktopBridge();
    await startBackend(port);
    await waitForHealth(port);
    activePort = port;
    desktopLog('renderer_origin', `http://127.0.0.1:${port}`);
    createWindow(`http://127.0.0.1:${port}`);
  } catch (error) {
    errorWindow(error);
  }
}

async function stopBackend() {
  activePort = undefined;
  if (!backend?.pid) return;
  backend.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (backend?.pid) backend.kill('SIGKILL');
      resolve();
    }, 12_000);
    backend?.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

app.setName('مطعم أفندينا');
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  setupIpc();
  await launch();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) void launch();
});
app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void stopBackend().finally(() => {
    bridge?.close();
    if (process.platform !== 'win32' && bridgeSocket)
      fs.rmSync(bridgeSocket, { force: true });
    app.quit();
  });
});
