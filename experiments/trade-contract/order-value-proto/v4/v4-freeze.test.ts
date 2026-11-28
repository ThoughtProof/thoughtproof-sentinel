import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('order-value v4 freeze', () => {
  it('matches the frozen file set and the freeze hash', () => {
    const manifestPath = new URL('./v4-freeze-manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      candidateCommit: string;
      files: { path: string; sha256: string }[];
      frozenImports: { path: string; sha256: string }[];
      harnessImports: { path: string; sha256: string }[];
    };
    expect(manifest.candidateCommit).toBe('aac713cd3a37bb04e89064299d57b342fa224718');
    expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex'))
      .toBe('9b7094e9dca05c4ccd7503990f13e4133b54c83bced8c480cd128e30413eb0ff');
    for (const file of [...manifest.files, ...manifest.frozenImports, ...manifest.harnessImports]) {
      const bytes = readFileSync(new URL(`../../../../${file.path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
    }
  });
});
