import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export type DesktopCapability = { available: boolean; message: string };

export function desktopCapability(): DesktopCapability {
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
  if (!desktopCapability().available)
    throw new Error(desktopCapability().message);
  if (process.platform === 'win32') {
    await executeFile('explorer.exe', [directory], { windowsHide: true });
    return;
  }
  await executeFile('xdg-open', [directory], { timeout: 15_000 });
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
