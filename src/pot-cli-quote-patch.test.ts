/**
 * Lock the published pot-cli release containing the Sentinel quote fixes.
 *
 * Must fail if someone swaps back an unpatched upstream 0.8.10 tarball
 * that happens to export the same function names.
 */
import { readFileSync } from 'node:fs';
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
export const POT_CLI_VERSION = '0.8.13';
export const POT_CLI_TARBALL = 'https://registry.npmjs.org/pot-cli/-/pot-cli-0.8.13.tgz';
export const POT_CLI_INTEGRITY =
  'sha512-/n7JCI+fAUEDytCW/aPZQxhZm9IMeKr0KZM5+BBGJmhgRFyjaQUxByCD391AXkLX+DPk5xf5VfG0/fyXxS+PKA==';

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

describe('published pot-cli identity with the Sentinel fixes', () => {
  it('installed package and health version match the pinned npm release', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'node_modules', 'pot-cli', 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(pkg.name).toBe('pot-cli');
    expect(pkg.version).toBe(POT_CLI_VERSION);
    expect(pkg.version).not.toBe('0.8.10');
    expect(getPotCliVersion()).toBe(POT_CLI_VERSION);
  });

  it('manifest and lockfile pin the audited npm tarball and integrity', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
    expect(manifest.dependencies['pot-cli']).toBe(POT_CLI_VERSION);
    expect(lock.packages[''].dependencies['pot-cli']).toBe(POT_CLI_VERSION);
    expect(lock.packages['node_modules/pot-cli']).toMatchObject({
      version: POT_CLI_VERSION,
      resolved: POT_CLI_TARBALL,
      integrity: POT_CLI_INTEGRITY,
    });
    const patches = readFileSync(join(process.cwd(), 'vendor', 'PATCHES.md'), 'utf8');
    expect(patches).toContain(POT_CLI_VERSION);
    expect(patches).toContain(POT_CLI_TARBALL);
    expect(patches).toContain(POT_CLI_INTEGRITY);
  });

  it('installed evaluator source has the Sentinel patch markers (not stub exports)', () => {
    const src = readFileSync(
      join(process.cwd(), 'node_modules', 'pot-cli', 'dist', 'plan', 'graded-support-evaluator.js'),
      'utf8',
    );
    expect(src).toContain("raw === 'undefined' || raw === 'null'");
    expect(src).toContain('Principal mandate \\(verbatim quote\\):');
    expect(src).toContain('USER INSTRUCTION:');
    expect(src).toContain('recoverCiteableQuote(coerceQuote(ev.quote)');
    expect(src).toContain('appendReasoningNote(processed.reasoning');
    // Unpatched 0.8.10 used reasoning += which produces the undefined prefix.
    expect(src).not.toMatch(
      /processed\.reasoning \+= ['"] \[PROVENANCE DOWNGRADE: quote invalid or missing\]['"]/,
    );
  });
});

describe('published pot-cli quote patch behavior', () => {
  it('coerceQuote treats omitted / undefined string as null', () => {
    expect(potCoerceQuote(undefined)).toBeNull();
    expect(potCoerceQuote(null)).toBeNull();
    expect(potCoerceQuote('undefined')).toBeNull();
  });

  it('Sentinel coerceQuote matches published pot-cli on shared cases (drift lock)', () => {
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
    // 0.8.13 routes recovery through inspectMandateVerbatimQuote.
    // extractMandateVerbatimQuote is a wrapper over that inspector, not the callee.
    expect(recoverCiteableQuote.toString()).toContain('inspectMandateVerbatimQuote');
    expect(recoverCiteableQuote.toString()).not.toContain('extractMandateVerbatimQuote');
  });

  it('recoverCiteableQuote pulls suite USER INSTRUCTION when quote is null', () => {
    const evidence =
      'USER INSTRUCTION: Swap 100 USDC for ETH on Uniswap. WALLET BALANCE: 5,000 USDC. ' +
      'AGENT PROPOSED ACTION: approve(0xUNIROUTER, 100 USDC). AGENT REASONING: exact amount.';
    expect(recoverCiteableQuote(null, evidence)).toBe(
      'Swap 100 USDC for ETH on Uniswap.',
    );
    expect(recoverCiteableQuote('model cited this', evidence)).toBe('model cited this');
  });
});
