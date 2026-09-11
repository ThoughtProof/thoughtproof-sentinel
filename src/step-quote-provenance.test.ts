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
  matchEvidenceQuote,
  ACTION_AUTHORIZATION_CLAIM_SUFFIX,
  MCP_EVIDENCE_ACTION_LABEL,
  MCP_EVIDENCE_MANDATE_LABEL,
  MCP_EVIDENCE_REASONING_LABEL,
  normalizeStepQuote,
  PROVENANCE_DOWNGRADE_STAMP,
  RECOVERED_MANDATE_NOTE,
  sanitizeReasoning,
} from './step-quote-provenance.js';

const FYI_MANDATE = 'Tell CoS host runs git main';

/**
 * Byte-compatible with thoughtproof-mcp `buildSentinelEvidence` when the
 * host quote is omitted (quote === full mandate, no fallback note).
 */
function mcpBuildSentinelEvidence(input: {
  mandate: string;
  proposed_action: string;
  reasoning: string;
  context?: string;
}): string {
  const parts = [
    MCP_EVIDENCE_MANDATE_LABEL,
    input.mandate,
    '',
    MCP_EVIDENCE_ACTION_LABEL,
    input.proposed_action,
    '',
    MCP_EVIDENCE_REASONING_LABEL,
    input.reasoning,
  ];
  if (input.context) {
    parts.push('', 'Context:', input.context);
  }
  return parts.join('\n');
}

const fyiEvidence = mcpBuildSentinelEvidence({
  mandate: FYI_MANDATE,
  proposed_action: FYI_MANDATE,
  reasoning: 'FYI to CoS that the host is running on git main.',
});

const shipEvidence = mcpBuildSentinelEvidence({
  mandate: 'Ship the release only after pinning the npm version and CI is green.',
  proposed_action: 'Notify CoS that we are shipping now.',
  reasoning: 'Notify chief of staff; do not pin npm or wait for CI.',
});

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

describe('MCP evidence contract (thoughtproof-mcp buildSentinelEvidence)', () => {
  it('parses the exact MCP builder output including a multiline mandate', () => {
    // Mirrors thoughtproof-mcp test/verify-decision.test.js:
    // /Principal mandate \(verbatim quote\):\nShip the release\nto production/
    const evidence = mcpBuildSentinelEvidence({
      mandate: 'Ship the release\nto production',
      proposed_action: 'Deploy the API to production',
      reasoning: 'CI is green; send-to-prod now',
    });
    expect(evidence).toContain(`${MCP_EVIDENCE_MANDATE_LABEL}\nShip the release\nto production`);
    expect(extractMandateVerbatimQuote(evidence)).toBe('Ship the release\nto production');
  });

  it('parses MCP output that includes the host-quote fallback note', () => {
    const evidence = [
      '[ThoughtProof quote] host quote rejected (too_short; floor is 20 characters); using full mandate for provenance.',
      '',
      MCP_EVIDENCE_MANDATE_LABEL,
      'Ship it',
      '',
      MCP_EVIDENCE_ACTION_LABEL,
      'Ship it',
      '',
      MCP_EVIDENCE_REASONING_LABEL,
      'ok',
    ].join('\n');
    // Short embedded span is valid — MCP 20-char floor is host-excerpt only.
    expect(extractMandateVerbatimQuote(evidence)).toBe('Ship it');
  });

  it('uses the declared format labels as the cross-repo marker', () => {
    expect(MCP_EVIDENCE_MANDATE_LABEL).toBe('Principal mandate (verbatim quote):');
    expect(fyiEvidence.startsWith(`${MCP_EVIDENCE_MANDATE_LABEL}\n${FYI_MANDATE}`)).toBe(
      true,
    );
    expect(ACTION_AUTHORIZATION_CLAIM_SUFFIX).toBe(
      " is authorized by the principal's mandate",
    );
  });
});

describe('matchEvidenceQuote returns the actually matched span', () => {
  it('returns the evidence span for a unicode-folded match', () => {
    const evidence = 'the principal said hello\u2014world today';
    const m = matchEvidenceQuote('hello-world', evidence);
    expect(m.matched).toBe(true);
    expect(m.match_mode).toBe('unicode');
    expect(m.span).toBe('hello\u2014world');
    expect(evidence.includes(m.span!)).toBe(true);
  });

  it('returns an evidence.substring span for line_whitespace (not stripped normQuote)', () => {
    // Quote indent is spaces; evidence indent is a tab. Exact/trimmed fail;
    // per-line leading-ws fold matches. Span must still live in raw evidence.
    const evidence = 'lead\n\tfoo\n\tbar\ntrail';
    const m = matchEvidenceQuote('foo\n  bar', evidence);
    expect(m.matched).toBe(true);
    expect(m.match_mode).toBe('line_whitespace');
    expect(m.span).toBeTruthy();
    expect(evidence.includes(m.span!)).toBe(true);
    expect(m.span).toBe('foo\n\tbar');
  });
});

describe('FYI-aligned (mandate ≈ action, MCP mandate span present)', () => {
  it('recovers a labeled mandate quote and does not emit undefined [PROVENANCE', () => {
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
    expect(n.quote_source).toBe('recovered_mandate');
    expect(n.false_provenance_stripped).toBe(true);
    expect(n.reasoning).not.toMatch(/undefined\s*\[PROVENANCE/i);
    expect(n.reasoning).not.toContain('PROVENANCE DOWNGRADE');
    expect(n.reasoning.toLowerCase()).toContain(RECOVERED_MANDATE_NOTE);
  });

  it('extracts the MCP Principal mandate verbatim span', () => {
    expect(extractMandateVerbatimQuote(fyiEvidence)).toBe(FYI_MANDATE);
  });

  it('recovers on near-pass score without a provenance stamp', () => {
    const n = normalizeStepQuote(
      {
        predicate: 'weakly_faithful',
        score: 0.25,
        quote: null,
        reasoning: undefined,
      },
      fyiEvidence,
    );
    expect(n.quote_source).toBe('recovered_mandate');
    expect(n.quote).toBe(FYI_MANDATE);
    expect(n.reasoning.toLowerCase()).toContain(RECOVERED_MANDATE_NOTE);
  });
});

describe('Ship-mismatch (mandate = npm pin / ship, action = notify CoS)', () => {
  it('keeps real scope/objective objections and does not recover mandate cites', () => {
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
    expect(n.quote).toBeNull();
    expect(n.quote_source).toBeNull();
    expect(n.recovered_quote).toBe(false);
    expect(n.reasoning.toLowerCase()).not.toContain(RECOVERED_MANDATE_NOTE);
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
    expect(n.recovered_quote).toBe(false);
    expect(n.quote_source).toBeNull();
    expect(n.reasoning).toBe('Recipient / objective differs from the granted mandate.');
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
    expect(n.quote_source).toBeNull();
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
    expect(n.quote_source).toBeNull();
    expect(n.reasoning).toMatch(/not a substring/i);
  });
});
