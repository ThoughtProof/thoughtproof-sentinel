/**
 * Lock the vendored pot-cli 0.8.10-tp.1 ThoughtProof patch.
 *
 * Must fail if someone swaps back an unpatched upstream 0.8.10 tarball
 * that happens to export the same function names.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendReasoningNote,
  coerceQuote as potCoerceQuote,
  recoverCiteableQuote,
} from 'pot-cli/plv';
import { coerceQuote as sentinelCoerceQuote } from './step-quote-provenance.js';
import { getPotCliVersion } from './runtime-versions.js';

/** Must match vendor/PATCHES.md — bump both together. */
export const VENDORED_POT_CLI_VERSION = '0.8.10-tp.1';
export const VENDORED_POT_CLI_TGZ = 'vendor/pot-cli-0.8.10-tp.1.tgz';
export const VENDORED_POT_CLI_SHA512 =
  'ca96d9c03ec6f584cd3a4936ff7dcba7d0e372ef4efa5161f63f1bbefd8ab3434f3c4bba9de0e6602d2664a42af2c6bba36c43f7aa9073f7987653132e45bd95';

const COERCE_CASES: unknown[] = [
  undefined,
  null,
  'undefined',
  'null',
  '',
  '   ',
  'abc',
  42,
  'Tell CoS host runs git main',
];

describe('vendored pot-cli identity (not upstream 0.8.10)', () => {
  it('package.json version is the ThoughtProof prerelease, not 0.8.10', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'node_modules', 'pot-cli', 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(pkg.name).toBe('pot-cli');
    expect(pkg.version).toBe(VENDORED_POT_CLI_VERSION);
    expect(pkg.version).not.toBe('0.8.10');
    expect(getPotCliVersion()).toBe(VENDORED_POT_CLI_VERSION);
  });

  it('vendor tarball sha512 matches the pinned ThoughtProof patch', () => {
    const tgz = join(process.cwd(), VENDORED_POT_CLI_TGZ);
    expect(existsSync(tgz)).toBe(true);
    const hash = createHash('sha512').update(readFileSync(tgz)).digest('hex');
    expect(hash).toBe(VENDORED_POT_CLI_SHA512);
    const patches = readFileSync(join(process.cwd(), 'vendor', 'PATCHES.md'), 'utf8');
    expect(patches).toContain(VENDORED_POT_CLI_VERSION);
    expect(patches).toContain(VENDORED_POT_CLI_SHA512);
  });

  it('installed evaluator source has the Sentinel patch markers (not stub exports)', () => {
    const src = readFileSync(
      join(process.cwd(), 'node_modules', 'pot-cli', 'dist', 'plan', 'graded-support-evaluator.js'),
      'utf8',
    );
    expect(src).toContain("raw === 'undefined' || raw === 'null'");
    expect(src).toContain('Principal mandate \\(verbatim quote\\):');
    expect(src).toContain('recoverCiteableQuote(coerceQuote(ev.quote)');
    expect(src).toContain('appendReasoningNote(processed.reasoning');
    // Unpatched 0.8.10 used reasoning += which produces the undefined prefix.
    expect(src).not.toMatch(
      /processed\.reasoning \+= ['"] \[PROVENANCE DOWNGRADE: quote invalid or missing\]['"]/,
    );
  });
});

describe('vendored pot-cli quote patch behavior', () => {
  it('coerceQuote treats omitted / undefined string as null', () => {
    expect(potCoerceQuote(undefined)).toBeNull();
    expect(potCoerceQuote(null)).toBeNull();
    expect(potCoerceQuote('undefined')).toBeNull();
  });

  it('Sentinel coerceQuote matches vendored pot-cli on shared cases (drift lock)', () => {
    for (const c of COERCE_CASES) {
      expect(sentinelCoerceQuote(c)).toEqual(potCoerceQuote(c));
    }
  });

  it('appendReasoningNote does not prefix undefined (stub exports fail this)', () => {
    const stamp = '[PROVENANCE DOWNGRADE: quote invalid or missing]';
    const out = appendReasoningNote(undefined, stamp);
    expect(out).toBe(stamp);
    expect(out).not.toMatch(/undefined/);
    expect(appendReasoningNote.toString()).toContain("raw === 'undefined'");
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
    expect(recoverCiteableQuote.toString()).toContain('extractMandateVerbatimQuote');
  });
});
