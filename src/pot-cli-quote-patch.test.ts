/**
 * Lock the vendored pot-cli 0.8.10 Sentinel patch:
 * appendReasoningNote / recoverCiteableQuote / coerceQuote('undefined').
 */
import { describe, expect, it } from 'vitest';
import {
  appendReasoningNote,
  coerceQuote,
  recoverCiteableQuote,
} from 'pot-cli/plv';
import { getPotCliVersion } from './runtime-versions.js';

describe('vendored pot-cli quote patch', () => {
  it('still exposes pot_cli semver on the installed package (#30)', () => {
    expect(getPotCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(getPotCliVersion()).not.toBe('unavailable');
  });

  it('coerceQuote treats omitted / undefined string as null', () => {
    expect(coerceQuote(undefined)).toBeNull();
    expect(coerceQuote(null)).toBeNull();
    expect(coerceQuote('undefined')).toBeNull();
  });

  it('appendReasoningNote does not prefix undefined', () => {
    const stamp = '[PROVENANCE DOWNGRADE: quote invalid or missing]';
    expect(appendReasoningNote(undefined, stamp)).toBe(stamp);
    expect(appendReasoningNote(undefined, stamp).startsWith('undefined')).toBe(false);
  });

  it('recoverCiteableQuote pulls MCP mandate span when quote is null', () => {
    const evidence = [
      'Principal mandate (verbatim quote):',
      'Tell CoS host runs git main',
      '',
      'Proposed action:',
      'Tell CoS host runs git main',
    ].join('\n');
    expect(recoverCiteableQuote(null, evidence)).toBe('Tell CoS host runs git main');
  });
});
