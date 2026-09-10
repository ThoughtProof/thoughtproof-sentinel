/**
 * Permanent banned=0 ratchet: `financial_pair_pass` /
 * `informational_pair_pass` must never reappear as promotion reasons.
 *
 * Same spirit as `src/pot-cli-quote-patch.test.ts` (source-marker lock):
 * a deterministic ALLOW override that lifts cascade BLOCK → public ALLOW
 * is an explicit Non-Goal (#34/#37). Prompt-only #55 hints may remain;
 * this test fails if those reason strings/values creep back into the
 * promotion union or any non-test engine source.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActionAuthPromotionReason } from './verdict.js';

export const BANNED_PAIR_PASS_REASONS = [
  'financial_pair_pass',
  'informational_pair_pass',
] as const;

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walkProductionTs(p));
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

function bannedHits(src: string): string[] {
  return BANNED_PAIR_PASS_REASONS.filter((reason) => src.includes(reason));
}

describe('banned pair-pass ALLOW reasons (Non-Goal #34/#37)', () => {
  it('ActionAuthPromotionReason union has banned=0 pair-pass reasons', () => {
    const src = readFileSync(join(process.cwd(), 'src/engine/verdict.ts'), 'utf8');
    const union = src.match(/export type ActionAuthPromotionReason =([\s\S]*?);/);
    expect(union, 'ActionAuthPromotionReason union must exist').toBeTruthy();
    const hits = bannedHits(union![1]!);
    expect(hits.length, `banned reasons in ActionAuthPromotionReason: ${hits.join(', ')}`).toBe(
      0,
    );
  });

  it('production src has banned=0 pair-pass reason strings', () => {
    const files = walkProductionTs(join(process.cwd(), 'src'));
    const hits: string[] = [];
    for (const file of files) {
      const found = bannedHits(readFileSync(file, 'utf8'));
      for (const reason of found) {
        hits.push(`${file.replace(`${process.cwd()}/`, '')}:${reason}`);
      }
    }
    expect(hits.length, `banned pair-pass strings: ${hits.join(', ')}`).toBe(0);
  });

  it('type-level: banned reasons are not members of ActionAuthPromotionReason', () => {
    type Banned = (typeof BANNED_PAIR_PASS_REASONS)[number];
    type Extracted = Extract<ActionAuthPromotionReason, Banned>;
    type AssertNever<T> = [T] extends [never] ? true : false;
    const absent: AssertNever<Extracted> = true;
    expect(absent).toBe(true);
  });
});
