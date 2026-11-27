import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planHoldout } from './direct-holdout-plan.ts';

const root = new URL('../../', import.meta.url);

describe('strict binding freeze', () => {
  it('fails if the binding files drift from the manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('./direct-binding-manifest.json', import.meta.url), 'utf8')) as {
      files: { path: string; sha256: string }[];
      sentinelManifestSha256: string;
    };
    expect(manifest.sentinelManifestSha256).toBe('e591e341b04b1f339e56a34a2a592db91cfc0647b79afc094f4d11b688630f98');
    for (const file of manifest.files) {
      const bytes = readFileSync(new URL(file.path, root));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
    const sentinel = readFileSync(new URL('experiments/trade-contract/direct-freeze-manifest.json', root));
    expect(createHash('sha256').update(sentinel).digest('hex')).toBe(manifest.sentinelManifestSha256);
    const body = readFileSync(new URL('./direct-binding-manifest.json', import.meta.url));
    expect(createHash('sha256').update(body).digest('hex'))
      .toBe('e01e59a4601e783f37152e791fe7788a7e4afb9682543c88a3b0355b5bf49909');
  });
});

describe('holdout request hashes', () => {
  it('records six reachable cases and recomputes them when the package is present', () => {
    const saved = JSON.parse(readFileSync(new URL('./fixtures/direct-preflight/holdout-request-hashes.json', import.meta.url), 'utf8')) as {
      casesMatch: boolean;
      scoringFileInPackage: boolean;
      rows: { caseId: string; gatewayPassed: boolean; criticReached: boolean; documentsEqual: boolean; actionUnchanged: boolean; secondary_called: boolean; public_verdict_stage: string }[];
    };
    expect(saved.casesMatch).toBe(true);
    expect(saved.scoringFileInPackage).toBe(false);
    expect(saved.rows).toHaveLength(6);
    expect(saved.rows.every(row => row.gatewayPassed && row.criticReached && row.documentsEqual && row.actionUnchanged)).toBe(true);
    expect(saved.rows.every(row => row.secondary_called === false && row.public_verdict_stage === 'none')).toBe(true);
    const zip = '/cursor/stores/self/holdout-input-20261127/input.zip';
    if (!existsSync(zip)) return;
    const dir = mkdtempSync(join(tmpdir(), 'holdout-'));
    try {
      expect(spawnSync('unzip', ['-q', zip, '-d', dir], { encoding: 'utf8' }).status).toBe(0);
      const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')) as { cases?: unknown[] } | unknown[];
      const list = Array.isArray(cases) ? cases : cases.cases;
      expect(planHoldout(list as never)).toEqual(saved.rows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
