import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order-value v5 freeze', () => {
  it('matches the frozen file set, the comparison entry, and the freeze hash', () => {
    const manifestPath = new URL('./v5-freeze-manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      candidateCommit: string;
      comparisonEntry: string;
      files: { path: string; sha256: string }[];
      frozenImports: { path: string; sha256: string }[];
      harnessImports: { path: string; sha256: string }[];
    };
    expect(manifest.candidateCommit).toBe('e0759caa29b86f00bbde8e3b2d1b0e2fb0b0a441');
    expect(manifest.comparisonEntry).toBe('experiments/trade-contract/order-value-proto/v5/comparison.ts');
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'))
      .toBe('4a8d8fe9bf0a2d5353c5866dc3c2ddb00187b71277329530f77bec16edc4b27a');
    for (const file of [...manifest.files, ...manifest.frozenImports, ...manifest.harnessImports]) {
      const bytes = readFileSync(new URL(`../../../../${file.path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });
});
