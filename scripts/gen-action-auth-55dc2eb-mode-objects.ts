#!/usr/bin/env -S npx tsx
/**
 * Snapshot the REAL 55dc2eb action_authorization mode objects for the 27
 * suite scenarios (acceptance point 1 of the LOCAL_COMMAND_CRITERION scope
 * fix). Offline: no network, no provider, no Sentinel call.
 *
 * The old builder is imported from a separate checkout of 55dc2eb, not
 * copied into this repo. The test compares the new builder's output to
 * these objects with a deep, key-order-sensitive comparison.
 *
 *   git worktree add --detach /tmp/sentinel-55dc2eb 55dc2eb836d027227318e17600f836110ce0a00f
 *   ln -s "$PWD/node_modules" /tmp/sentinel-55dc2eb/node_modules
 *   npx tsx scripts/gen-action-auth-55dc2eb-mode-objects.ts /tmp/sentinel-55dc2eb
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASELINE_COMMIT = '55dc2eb836d027227318e17600f836110ce0a00f';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'test', 'fixtures', 'action-auth-mode-objects-55dc2eb');
const baselineDir = resolve(process.argv[2] ?? '');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

if (!process.argv[2]) throw new Error('usage: gen-action-auth-55dc2eb-mode-objects.ts <55dc2eb checkout>');
const head = git(baselineDir, 'rev-parse', 'HEAD');
if (head !== BASELINE_COMMIT) throw new Error(`baseline checkout is at ${head}, expected ${BASELINE_COMMIT}`);
if (git(baselineDir, 'status', '--porcelain', '--untracked-files=no', '--', 'src', 'scenarios') !== '') {
  throw new Error('baseline checkout has local changes under src/ or scenarios/');
}

const scenariosPath = join(repoRoot, 'scenarios', 'action-authorization-suite.json');
const scenariosText = readFileSync(scenariosPath, 'utf8');
const baselineScenariosText = readFileSync(join(baselineDir, 'scenarios', 'action-authorization-suite.json'), 'utf8');
if (scenariosText !== baselineScenariosText) throw new Error('suite scenarios differ from the 55dc2eb copy');
const scenarios = JSON.parse(scenariosText).scenarios as Array<Record<string, unknown>>;

const modUrl = pathToFileURL(join(baselineDir, 'src', 'engine', 'modes', 'action_authorization.ts')).href;
const { actionAuthorization } = (await import(modUrl)) as {
  actionAuthorization: (input: Record<string, unknown>) => unknown;
};

const objects: Record<string, unknown> = {};
for (const s of scenarios) {
  const input = {
    id: s.id,
    claim: s.claim,
    evidence: s.evidence,
    mode: 'action_authorization',
    ...(s.mandate !== undefined ? { mandate: s.mandate } : {}),
  };
  objects[String(s.id)] = actionAuthorization(input);
}
const objectsText = JSON.stringify(objects, null, 2) + '\n';

const builderFiles = [
  'src/engine/modes/action_authorization.ts',
  'src/engine/modes/types.ts',
  'src/engine/action-auth-kind.ts',
  'src/engine/authorization-gate.ts',
  'src/step-quote-provenance.ts',
];
const blobs: Record<string, string> = {};
for (const f of builderFiles) blobs[f] = git(baselineDir, 'rev-parse', `${BASELINE_COMMIT}:${f}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'objects.json'), objectsText);
writeFileSync(
  join(outDir, 'PROVENANCE.json'),
  JSON.stringify(
    {
      purpose:
        'Real action_authorization mode objects built by the 55dc2eb builder for the 27 suite scenarios. LOCAL_COMMAND_CRITERION scope fix, acceptance point 1.',
      baseline_commit: BASELINE_COMMIT,
      baseline_builder_blobs: blobs,
      generator: 'scripts/gen-action-auth-55dc2eb-mode-objects.ts',
      input_shape: '{ id, claim, evidence, mode: "action_authorization", mandate? } per scenario (engine verify() call shape)',
      scenarios_file: 'scenarios/action-authorization-suite.json',
      scenarios_sha256: sha256(scenariosText),
      n_cases: scenarios.length,
      objects_sha256: sha256(objectsText),
      network: 'none',
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ n_cases: scenarios.length, objects_sha256: sha256(objectsText) }));
