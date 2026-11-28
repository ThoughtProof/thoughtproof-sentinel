import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order-value v6 freeze', () => {
  it('matches the frozen file set, the comparison entry, and the freeze hash', () => {
    const manifestPath = new URL('./v6-freeze-manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      candidateCommit: string;
      comparisonEntry: string;
      files: { path: string; sha256: string }[];
      frozenImports: { path: string; sha256: string }[];
      harnessImports: { path: string; sha256: string }[];
    };
    expect(manifest.candidateCommit).toBe('66dcfd9eba43698f9e2d286aefa16a7d2b747cac');
    expect(manifest.comparisonEntry).toBe('experiments/trade-contract/order-value-proto/v6/comparison.ts');
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'))
      .toBe('0842e2b23ee5bece201a747c6f0fbc1da5be3a1ead51a56edc25ff23a8e9c404');
    for (const file of [...manifest.files, ...manifest.frozenImports, ...manifest.harnessImports]) {
      const bytes = readFileSync(new URL(`../../../../${file.path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });
});
