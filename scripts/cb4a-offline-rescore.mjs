/**
 * Offline re-score of the recorded CB4A captures.
 *
 *   node scripts/cb4a-offline-rescore.mjs
 *
 * Runs the vitest entry so TypeScript path resolution matches the unit tests.
 * No model call, no Sentinel deployment. Prints the verdict table as JSON.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  'npx',
  ['vitest', 'run', 'src/engine/cb4a-offline-rescore.test.ts', 'src/engine/cb4a-step0-rescore.test.ts', '--reporter=dot'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CB4A_RESCORE_PRINT: '1' },
  },
);
process.exit(result.status ?? 1);
