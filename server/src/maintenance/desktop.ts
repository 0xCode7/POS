import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export type DesktopCapability = { available: boolean; message: string };

export function desktopCapability(): DesktopCapability {
  if (electronBridgeAvailable())
    return {
      available: true,
      message: 'اختيار المجلد وفتحه مدعومان من تطبيق سطح المكتب المحلي.',
    };
  if (process.platform === 'win32')
    return {
      available: true,
      message: 'اختيار المجلد وفتحه مدعومان في Windows عبر أدوات محلية ثابتة.',
    };
  if (
    process.platform === 'linux' &&
    fs.existsSync('/usr/bin/zenity') &&
    Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  )
    return {
      available: true,
      message: 'اختيار المجلد وفتحه مدعومان في جلسة سطح المكتب الحالية.',
    };
  return {
    available: false,
    message:
      'اختيار أو فتح المجلد الرسومي غير متاح في جلسة التشغيل الحالية. استخدم المسار اليدوي.',
  };
}

export async function chooseDirectory(): Promise<string | undefined> {
  if (electronBridgeAvailable()) {
    const reply = (await electronBridge('pick-directory')) as {
      directory?: string;
    };
    return reply.directory;
  }
  if (process.platform === 'win32') {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const script = path.join(moduleDirectory, 'windows-folder-picker.ps1');
    if (!fs.existsSync(script))
      throw new Error('ملف اختيار المجلد في Windows غير موجود.');
    return dialogResult('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
    ]);
  }
  if (process.platform === 'linux' && desktopCapability().available)
    return dialogResult('/usr/bin/zenity', [
      '--file-selection',
      '--directory',
      '--title=اختيار مجلد النسخ الاحتياطية',
    ]);
  throw new Error(desktopCapability().message);
}

export async function openDirectory(directory: string) {
  if (electronBridgeAvailable()) {
    await electronBridge('open-directory', directory);
    return;
  }
  if (!desktopCapability().available)
    throw new Error(desktopCapability().message);
  if (process.platform === 'win32') {
    await executeFile('explorer.exe', [directory], { windowsHide: true });
    return;
  }
  await executeFile('xdg-open', [directory], { timeout: 15_000 });
}

function electronBridgeAvailable() {
  return Boolean(
    process.env.POS_ELECTRON_BRIDGE_SOCKET &&
    process.env.POS_ELECTRON_BRIDGE_SECRET,
  );
}

function electronBridge(
  action: 'pick-directory' | 'open-directory',
  directory?: string,
) {
  const socket = process.env.POS_ELECTRON_BRIDGE_SOCKET;
  const secret = process.env.POS_ELECTRON_BRIDGE_SECRET;
  if (!socket || !secret)
    throw new Error('جسر تطبيق سطح المكتب المحلي غير متاح.');
  return new Promise<unknown>((resolve, reject) => {
    const connection = net.createConnection(socket);
    let response = '';
    const timeout = setTimeout(() => {
      connection.destroy();
      reject(new Error('انتهت مهلة الاتصال بتطبيق سطح المكتب.'));
    }, 125_000);
    connection.setEncoding('utf8');
    connection.on('connect', () =>
      connection.end(`${JSON.stringify({ secret, action, directory })}\n`),
    );
    connection.on('data', (chunk) => (response += chunk));
    connection.on('error', reject);
    connection.on('close', () => {
      clearTimeout(timeout);
      try {
        const reply = JSON.parse(response) as {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
        if (!reply.ok)
          reject(new Error(reply.error ?? 'فشل طلب تطبيق سطح المكتب.'));
        else resolve(reply.result);
      } catch (error) {
        reject(new Error('رد تطبيق سطح المكتب غير صالح.', { cause: error }));
      }
    });
  });
}

async function dialogResult(command: string, arguments_: string[]) {
  try {
    const { stdout } = await executeFile(command, arguments_, {
      timeout: 120_000,
      maxBuffer: 8 * 1024,
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    throw new Error('تعذر فتح نافذة اختيار المجلد المحلية.', { cause: error });
  }
}
