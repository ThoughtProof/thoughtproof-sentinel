/**
 * Lock the evaluator-contract overlay on the published 0.8.12 release.
 *
 * Must fail if someone swaps back an unpatched upstream 0.8.10 tarball
 * that happens to export the same function names.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
export const POT_CLI_VERSION = '0.8.12-eval-contract.6';
export const POT_CLI_TARBALL = 'file:vendor/pot-cli-0.8.12-eval-contract.6.tgz';
export const POT_CLI_INTEGRITY =
  'sha512-YbJ1tyqp7pjMWO/k3TYwhqje8Lo1SkKfDB+C/GdCOzE+/VXK3vSjOdZUd1Jq5fX0i3eTcaqa9XKeHdmvCPX+kw==';

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

describe('pinned pot-cli overlay identity with the Sentinel fixes', () => {
  it('installed package and health version identify the audited overlay', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'node_modules', 'pot-cli', 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(pkg.name).toBe('pot-cli');
    expect(pkg.version).toBe(POT_CLI_VERSION);
    expect(pkg.version).not.toBe('0.8.10');
    expect(getPotCliVersion()).toBe(POT_CLI_VERSION);
  });

  it('manifest, lockfile and actual archive pin the audited overlay', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
    expect(manifest.dependencies['pot-cli']).toBe(POT_CLI_TARBALL);
    expect(lock.packages[''].dependencies['pot-cli']).toBe(POT_CLI_TARBALL);
    expect(lock.packages['node_modules/pot-cli']).toMatchObject({
      version: POT_CLI_VERSION,
      resolved: POT_CLI_TARBALL,
      integrity: POT_CLI_INTEGRITY,
    });
    const patches = readFileSync(join(process.cwd(), 'vendor', 'PATCHES.md'), 'utf8');
    expect(patches).toContain(POT_CLI_VERSION);
    expect(patches).toContain(POT_CLI_TARBALL);
    expect(patches).toContain(POT_CLI_INTEGRITY);
    const archive = readFileSync(join(process.cwd(), POT_CLI_TARBALL.slice('file:'.length)));
    expect('sha512-' + createHash('sha512').update(archive).digest('base64')).toBe(POT_CLI_INTEGRITY);
    const base = readFileSync(join(process.cwd(), 'vendor/pot-cli-0.8.12.tgz'));
    expect(createHash('sha256').update(base).digest('hex')).toBe('aaf93fe02d58e804323ccd1836ec00e268269db398af406adb905a7c67701ad1');
    // Keep the published release's Node and bridge corrections when rebasing the overlay.
    const installed = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/pot-cli/package.json'), 'utf8'));
    expect(installed.engines.node).toBe('>=22');
    expect(installed.dependencies['@pot-sdk2/bridge']).toBe('1.2.0');
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
    expect(src).toContain('decodeEvaluationOutput');
    expect(src).toContain('tier1ResolvedEvals.includes(ev)');
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
    expect(recoverCiteableQuote.toString()).toContain('extractMandateVerbatimQuote');
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
