import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDirectory } from '../db/database.js';
import { restoreBackup } from './restore.js';
import { acquireRuntimeLock } from './runtime-lock.js';

type Operation = {
  id: string;
  status:
    | 'IDLE'
    | 'PREPARING'
    | 'STOPPING'
    | 'RESTORING'
    | 'RESTARTING'
    | 'VERIFYING'
    | 'SUCCESS'
    | 'FAILED'
    | 'RECOVERY_REQUIRED';
  filename?: string;
  updatedAt: string;
  message: string;
};

const dataDirectory = resolveDataDirectory();
const requestedPort = Number(process.env.PORT ?? 3000);
const port = Number.isInteger(requestedPort) ? requestedPort : 3000;
const socket = supervisorSocket(dataDirectory);
const secret = randomBytes(32).toString('base64url');
const controlSecret =
  process.env.POS_SUPERVISOR_CONTROL_SECRET ??
  randomBytes(32).toString('base64url');
const statusFile = path.join(dataDirectory, 'restore-operation.json');
const controlFile = path.join(
  dataDirectory,
  '.restaurant-pos-supervisor-control.json',
);
let child: ChildProcess | undefined;
let operation: Operation = readOperation() ?? idle();
let shuttingDown = false;

fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const releaseSupervisorLock = acquireRuntimeLock(
  dataDirectory,
  'supervisor',
  '.restaurant-pos-supervisor.lock',
);
writeControlFile();
if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
const ipc = net.createServer((connection) => void handleConnection(connection));
ipc.listen(socket, () => {
  console.log('Restaurant POS supervisor is ready.');
  startBackend();
});

function handleConnection(connection: net.Socket) {
  let raw = '';
  let handled = false;
  connection.setEncoding('utf8');
  // A local client may be closed while a reply is being written (notably with
  // Windows named pipes). An IPC client disconnect must never terminate the
  // Supervisor, because it owns the payment-serving backend process.
  connection.on('error', (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPIPE' && code !== 'ECONNRESET') {
      console.error(`Supervisor IPC connection error: ${code ?? error.name}`);
    }
  });
  connection.on('data', (chunk) => {
    raw += chunk;
    const newline = raw.indexOf('\n');
    if (handled || newline === -1) return;
    handled = true;
    handleMessage(connection, raw.slice(0, newline));
  });
  connection.on('end', () => {
    if (handled) return;
    handled = true;
    handleMessage(connection, raw);
  });
}

function handleMessage(connection: net.Socket, raw: string) {
  try {
    const message = JSON.parse(raw) as {
      secret?: string;
      controlSecret?: string;
      method?: string;
      params?: {
        filename?: string;
        token?: string;
        actorId?: string;
        expiresAt?: string;
      };
    };
    if (message.method === 'stop') {
      if (message.controlSecret !== controlSecret)
        return reply(connection, false, undefined, 'طلب IPC غير مصرح به.');
      reply(connection, true, { stopping: true });
      setImmediate(shutdownSupervisor);
      return;
    }
    if (message.secret !== secret)
      return reply(connection, false, undefined, 'طلب IPC غير مصرح به.');
    if (message.method === 'status')
      return reply(connection, true, {
        ready: Boolean(child?.pid),
        operation,
      });
    if (
      message.method !== 'restore' ||
      !message.params?.filename ||
      !message.params.token ||
      !message.params.actorId ||
      !message.params.expiresAt
    )
      return reply(connection, false, undefined, 'طلب الاستعادة غير صالح.');
    if (
      Date.parse(message.params.expiresAt) <= Date.now() ||
      active(operation.status)
    )
      return reply(connection, false, undefined, 'الاستعادة غير متاحة حاليًا.');
    operation = update({
      id: createHash('sha256')
        .update(message.params.token)
        .digest('hex')
        .slice(0, 16),
      status: 'PREPARING',
      filename: message.params.filename,
      updatedAt: new Date().toISOString(),
      message: 'جارٍ تجهيز الاستعادة.',
    });
    reply(connection, true, { accepted: true, operation });
    void restoreManaged(message.params.filename);
  } catch {
    reply(connection, false, undefined, 'طلب IPC غير صالح.');
  }
}

async function restoreManaged(filename: string) {
  try {
    operation = update({
      ...operation,
      status: 'STOPPING',
      updatedAt: now(),
      message: 'جارٍ إيقاف الخدمة.',
    });
    await stopBackend();
    operation = update({
      ...operation,
      status: 'RESTORING',
      updatedAt: now(),
      message: 'جارٍ استعادة قاعدة البيانات والتحقق منها.',
    });
    await restoreBackup({ dataDirectory, filename, trustedSupervisor: true });
    operation = update({
      ...operation,
      status: 'RESTARTING',
      updatedAt: now(),
      message: 'جارٍ إعادة تشغيل الخدمة.',
    });
    startBackend();
    operation = update({
      ...operation,
      status: 'VERIFYING',
      updatedAt: now(),
      message: 'جارٍ التحقق من التشغيل.',
    });
    await healthCheck();
    operation = update({
      ...operation,
      status: 'SUCCESS',
      updatedAt: now(),
      message: 'اكتملت الاستعادة والتحقق بنجاح. سجّل الدخول مجددًا.',
    });
  } catch (error) {
    operation = update({
      ...operation,
      status: child ? 'FAILED' : 'RECOVERY_REQUIRED',
      updatedAt: now(),
      message: error instanceof Error ? error.message : 'فشلت الاستعادة.',
    });
    if (!child) startBackend();
  }
}

function startBackend() {
  if (child?.pid) return;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const serverEntry = path.resolve(moduleDirectory, '../index.js');
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    POS_SUPERVISOR_SOCKET: socket,
    POS_SUPERVISOR_SECRET: secret,
  };
  delete childEnvironment.POS_SUPERVISOR_CONTROL_SECRET;
  child = spawn(process.execPath, [serverEntry], {
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('exit', () => {
    child = undefined;
  });
}

async function stopBackend() {
  if (!child) return;
  const stopping = child;
  try {
    await waitForBackendExit(stopping, 20_000);
    return;
  } catch (error) {
    if (process.platform !== 'win32' || !stopping.pid) throw error;
    // This PID is the direct child created by this Supervisor. /t is deliberately
    // limited to that child's descendants; it cannot target an unrelated process.
    console.error(
      'Graceful backend shutdown timed out; ending managed process tree.',
    );
    const result = spawnSync('taskkill.exe', [
      '/pid',
      String(stopping.pid),
      '/t',
      '/f',
    ]);
    if (result.status !== 0 && result.status !== 128) {
      throw new Error('تعذر إنهاء عملية الخدمة المُدارة في Windows.', {
        cause: error,
      });
    }
    await waitForBackendExit(stopping, 10_000);
  }
}

function waitForBackendExit(stopping: ChildProcess, timeout: number) {
  if (stopping.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('تعذر إيقاف الخدمة في الوقت المحدد.')),
      timeout,
    );
    stopping.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    if (!stopping.killed && !stopping.kill('SIGTERM')) {
      clearTimeout(timer);
      reject(new Error('تعذر إرسال طلب الإيقاف إلى الخدمة.'));
    }
  });
}

function healthCheck() {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const probe = () =>
      http
        .get(`http://127.0.0.1:${port}/api/health`, (response) => {
          response.resume();
          if (response.statusCode === 200) resolve();
          else retry();
        })
        .on('error', retry);
    const retry = () =>
      Date.now() >= deadline
        ? reject(new Error('لم ينجح فحص صحة الخدمة بعد الاستعادة.'))
        : setTimeout(probe, 300);
    probe();
  });
}

function reply(
  socket_: net.Socket,
  ok: boolean,
  result?: unknown,
  error?: string,
) {
  if (socket_.destroyed || !socket_.writable) return;
  try {
    socket_.end(`${JSON.stringify({ ok, result, error })}\n`);
  } catch (replyError) {
    const code = (replyError as NodeJS.ErrnoException).code;
    if (code !== 'EPIPE' && code !== 'ECONNRESET') {
      console.error(`Supervisor IPC reply error: ${code ?? 'unknown'}`);
    }
  }
}
function active(status: Operation['status']) {
  return [
    'PREPARING',
    'STOPPING',
    'RESTORING',
    'RESTARTING',
    'VERIFYING',
  ].includes(status);
}
function idle(): Operation {
  return {
    id: '',
    status: 'IDLE',
    updatedAt: now(),
    message: 'لا توجد عملية استعادة قيد التنفيذ.',
  };
}
function now() {
  return new Date().toISOString();
}
function update(next: Operation) {
  fs.writeFileSync(`${statusFile}.tmp`, `${JSON.stringify(next)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(`${statusFile}.tmp`, statusFile);
  return next;
}
function readOperation() {
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Operation;
  } catch {
    return undefined;
  }
}
function supervisorSocket(directory: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\restaurant-pos-${createHash('sha256').update(directory).digest('hex').slice(0, 20)}`
    : path.join(directory, '.restaurant-pos-supervisor.sock');
}
function shutdownSupervisor() {
  if (shuttingDown) return;
  shuttingDown = true;
  void stopBackend()
    .then(() => {
      ipc.close();
      fs.rmSync(controlFile, { force: true });
      if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
      releaseSupervisorLock();
      process.exit();
    })
    .catch((error: unknown) => {
      // Do not exit and orphan a backend that could still be serving payments.
      // Keep its IPC listener and lock/control record for a later safe retry.
      shuttingDown = false;
      console.error(
        'Restaurant POS Supervisor could not stop its managed backend:',
        error,
      );
    });
}

function writeControlFile() {
  const value = {
    pid: process.pid,
    socket,
    controlSecret,
    createdAt: now(),
  };
  const temporary = `${controlFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, controlFile);
}
process.on('SIGINT', shutdownSupervisor);
process.on('SIGTERM', shutdownSupervisor);
