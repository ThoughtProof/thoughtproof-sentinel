/**
 * Quote-null provenance — dogfood 2026-09-09
 *
 * Live /sentinel/verify action_authorization receipts (prod pot-cli 0.8.10):
 *   1. Ship-mismatch: unfaithful score 0, quote null → real scope objections
 *   2. FYI-aligned: weakly_faithful 0.25, quote null →
 *      `undefined [PROVENANCE DOWNGRADE: quote invalid or missing]`
 *      even though MCP evidence already has Principal mandate (verbatim quote).
 */
import { describe, it, expect } from 'vitest';
import {
  appendReasoningNote,
  coerceQuote,
  extractMandateVerbatimQuote,
  isEvidenceSubstring,
  normalizeStepQuote,
  PROVENANCE_DOWNGRADE_STAMP,
  sanitizeReasoning,
} from './step-quote-provenance.js';

const FYI_MANDATE = 'Tell CoS host runs git main';

function mcpEvidence(mandate: string, action: string, reasoning: string): string {
  return [
    `${'Principal mandate (verbatim quote)'}:`,
    mandate,
    '',
    'Proposed action:',
    action,
    '',
    'Agent reasoning:',
    reasoning,
  ].join('\n');
}

const fyiEvidence = mcpEvidence(
  FYI_MANDATE,
  FYI_MANDATE,
  'FYI to CoS that the host is running on git main.',
);

const shipEvidence = mcpEvidence(
  'Ship the release only after pinning the npm version and CI is green.',
  'Notify CoS that we are shipping now.',
  'Notify chief of staff; do not pin npm or wait for CI.',
);

describe('coerceQuote', () => {
  it('maps nullish and JS stringification artifacts to null', () => {
    expect(coerceQuote(undefined)).toBeNull();
    expect(coerceQuote(null)).toBeNull();
    expect(coerceQuote('undefined')).toBeNull();
    expect(coerceQuote('null')).toBeNull();
    expect(coerceQuote('')).toBeNull();
    expect(coerceQuote('   ')).toBeNull();
  });

  it('keeps real strings', () => {
    expect(coerceQuote('Tell CoS host runs git main')).toBe(
      'Tell CoS host runs git main',
    );
  });
});

describe('appendReasoningNote', () => {
  it('does not prefix the string undefined when quote/reasoning is null', () => {
    const out = appendReasoningNote(undefined, PROVENANCE_DOWNGRADE_STAMP);
    expect(out).toBe(PROVENANCE_DOWNGRADE_STAMP);
    expect(out.startsWith('undefined')).toBe(false);
    expect(appendReasoningNote(null, ` ${PROVENANCE_DOWNGRADE_STAMP}`)).toBe(
      PROVENANCE_DOWNGRADE_STAMP,
    );
  });
});

describe('sanitizeReasoning', () => {
  it('strips the JS undefined-concat artifact from pot-cli 0.8.10', () => {
    const garbled = `undefined ${PROVENANCE_DOWNGRADE_STAMP}`;
    expect(sanitizeReasoning(garbled)).toBe(PROVENANCE_DOWNGRADE_STAMP);
    expect(sanitizeReasoning(garbled)).not.toMatch(/^undefined /);
  });
});

describe('FYI-aligned (mandate ≈ action, MCP mandate span present)', () => {
  it('recovers an evidence-substring quote and does not emit undefined [PROVENANCE', () => {
    const n = normalizeStepQuote(
      {
        predicate: 'weakly_faithful',
        score: 0.25,
        quote: null,
        reasoning: `undefined ${PROVENANCE_DOWNGRADE_STAMP}`,
      },
      fyiEvidence,
    );

    expect(n.quote).toBe(FYI_MANDATE);
    expect(isEvidenceSubstring(n.quote!, fyiEvidence)).toBe(true);
    expect(n.recovered_quote).toBe(true);
    expect(n.false_provenance_stripped).toBe(true);
    expect(n.reasoning).not.toMatch(/undefined\s*\[PROVENANCE/i);
    expect(n.reasoning).not.toContain('PROVENANCE DOWNGRADE');
  });

  it('extracts the MCP Principal mandate verbatim span', () => {
    expect(extractMandateVerbatimQuote(fyiEvidence)).toBe(FYI_MANDATE);
  });
});

describe('Ship-mismatch (mandate = npm pin / ship, action = notify CoS)', () => {
  it('keeps real scope/objective objections and does not provenance-only fail', () => {
    const scope =
      'Action notifies CoS; mandate is about npm pin / ship — scope and objective mismatch.';
    const n = normalizeStepQuote(
      {
        predicate: 'unfaithful',
        score: 0,
        quote: null,
        reasoning: scope,
      },
      shipEvidence,
    );

    expect(n.reasoning).toBe(scope);
    expect(n.reasoning).not.toMatch(/undefined\s*\[PROVENANCE/i);
    expect(n.reasoning).not.toContain('PROVENANCE DOWNGRADE');
    expect(n.reasoning).toMatch(/scope|objective|npm pin/i);
    // Recovered cite is allowed (mandate is in evidence) but must be a substring.
    if (n.quote !== null) {
      expect(isEvidenceSubstring(n.quote, shipEvidence)).toBe(true);
    }
  });

  it('does not rewrite unfaithful steps that already have real prose', () => {
    const n = normalizeStepQuote(
      {
        predicate: 'unfaithful',
        score: 0,
        quote: null,
        reasoning: 'Recipient / objective differs from the granted mandate.',
      },
      shipEvidence,
    );
    expect(n.false_provenance_stripped).toBe(false);
    expect(n.reasoning).toContain('objective');
  });
});

describe('fail-closed when no citeable span exists', () => {
  it('emits a well-formed missing-quote objection, not undefined prefix', () => {
    const n = normalizeStepQuote(
      {
        predicate: 'weakly_faithful',
        score: 0.25,
        quote: null,
        reasoning: `undefined ${PROVENANCE_DOWNGRADE_STAMP}`,
      },
      'no mandate label here',
    );
    expect(n.quote).toBeNull();
    expect(n.reasoning).not.toMatch(/^undefined /);
    expect(n.reasoning).toMatch(/not a citeable substring/i);
  });

  it('drops a quote that is not an evidence substring', () => {
    const n = normalizeStepQuote(
      {
        predicate: 'faithful',
        score: 0.9,
        quote: 'this span is not in the evidence blob',
        reasoning: PROVENANCE_DOWNGRADE_STAMP,
      },
      fyiEvidence,
    );
    expect(n.quote).toBeNull();
    expect(n.reasoning).toMatch(/not a substring/i);
  });
});
