import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalModelConfigJson, MODEL_CONFIG } from './model-config.ts';
import { PROMPT_TEMPLATE, PROMPT_TEMPLATE_ID } from './prompt.ts';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('frozen candidate manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('./CANDIDATE.manifest.json', import.meta.url), 'utf8')) as {
    frozen: boolean;
    acceptance: { measured: boolean; falseAllowTarget: number; correctAllowMinimum: number };
    promptTemplates: { id: string; sha256: string }[];
    modelConfiguration: unknown;
    modelConfigurationSha256: string;
    sourceFiles: { path: string; sha256: string }[];
  };

  it('records the prompt, the pinned model configuration, and the source bytes', () => {
    expect(manifest.frozen).toBe(true);
    expect(manifest.acceptance.measured).toBe(false);
    expect(manifest.acceptance.falseAllowTarget).toBe(0);
    expect(manifest.acceptance.correctAllowMinimum).toBe(0.8);
    expect(manifest.promptTemplates).toEqual([{ id: PROMPT_TEMPLATE_ID, sha256: sha256(PROMPT_TEMPLATE) }]);
    expect(manifest.modelConfiguration).toEqual(MODEL_CONFIG);
    expect(manifest.modelConfigurationSha256).toBe(sha256(canonicalModelConfigJson()));
    expect(manifest.sourceFiles.map(file => file.path)).not.toContain('experiments/trade-contract/CANDIDATE.manifest.json');
    for (const file of manifest.sourceFiles) {
      const bytes = readFileSync(new URL(`../../${file.path}`, import.meta.url));
      expect(sha256(bytes)).toBe(file.sha256);
    }
  });
});
