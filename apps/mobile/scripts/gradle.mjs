import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

// Simple cross-platform wrapper to execute gradlew in the android folder
const args = process.argv.slice(2);
const isWin = platform() === 'win32';
const cmd = isWin ? 'gradlew.bat' : './gradlew';

console.log(`> Running ${cmd} ${args.join(' ')} in ./android`);

const result = spawnSync(cmd, args, {
  cwd: 'android',
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
