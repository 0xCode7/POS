import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
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
  connection.setEncoding('utf8');
  connection.on('data', (chunk) => (raw += chunk));
  connection.on('end', () => {
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
        return reply(
          connection,
          false,
          undefined,
          'الاستعادة غير متاحة حاليًا.',
        );
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
  });
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
  stopping.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('تعذر إيقاف الخدمة في الوقت المحدد.')),
      30_000,
    );
    stopping.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
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
  socket_.end(`${JSON.stringify({ ok, result, error })}\n`);
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
  ipc.close();
  void stopBackend().finally(() => {
    fs.rmSync(controlFile, { force: true });
    if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
    releaseSupervisorLock();
    process.exit();
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
