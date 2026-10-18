import { Writable } from 'node:stream';
import readline from 'node:readline/promises';
import { restoreBackup } from './restore.js';

const filename = argument('--file');
const username = argument('--username');
if (!filename || !username) {
  console.error(
    'Usage: npm run restore --workspace server -- --file <safe-backup-filename> --username <admin>',
  );
  process.exitCode = 2;
} else {
  const password = await secretPrompt('Admin password: ');
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const confirmation = await prompt.question(
    `Type RESTORE ${filename} to continue: `,
  );
  prompt.close();
  try {
    const result = await restoreBackup({
      filename,
      username,
      password,
      confirmation,
    });
    console.log(
      `Restore completed from ${result.restoredFrom}. All sessions were invalidated.`,
    );
    console.log(`Pre-restore backup: ${result.preRestoreBackup}`);
  } catch (error) {
    console.error(
      'Restore failed safely:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    process.exitCode = 1;
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function secretPrompt(label: string) {
  process.stdout.write(label);
  let muted = true;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const prompt = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const value = await prompt.question('');
  muted = false;
  prompt.close();
  process.stdout.write('\n');
  return value;
}
