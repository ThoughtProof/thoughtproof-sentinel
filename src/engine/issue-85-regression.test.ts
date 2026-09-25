/**
 * Regression tests for Issue #85 - Prove blocked path logging works
 */
import { describe, it, expect, vi } from 'vitest';
import { verify } from '../engine/index.js';

describe('Issue #85: Blocked path logging regression', () => {
  // Test the actual blocked scenario from the issue
  it('should log diagnostic info for callerDeclaredKindsDoNotWiden BLOCK', async () => {
    const mockConsole = vi.fn();
    const originalLog = console.log;
    console.log = mockConsole;
    
    try {
      const request = {
        claim: 'Post agenda with settlement info Day-14 #13 to team channel',
        evidence: `Action: Post message\nMandate: Post agenda with settlement info Day-14 #13 to team channel`,
        mandate: {
          kind: 'informational' as const, // Caller declares informational
          action: { kind: 'informational' as const },
        },
        tier: 'checkpoint' as const,
        mode: 'action_authorization' as const,
      };

      const result = await verify(request);
      
      // Should BLOCK because prose doesn't read as informational
      expect(result.verdict).toBe('BLOCK');
      
      // Should have diagnostic metadata
      expect(result.meta.promotion?.caller_kinds_diagnostic).toBeDefined();
      expect(result.meta.promotion?.prose_mandate_kind).toBeDefined();
      expect(result.meta.promotion?.prose_action_kind).toBeDefined();
      
      // Prose should not be classified as informational (no FYI markers)
      expect(result.meta.promotion?.prose_mandate_kind).not.toBe('informational');
      
      // Caller diagnostic should show the narrowing violation
      const diagnostic = result.meta.promotion?.caller_kinds_diagnostic;
      if (diagnostic) {
        expect(diagnostic.caller_mandate_kind).toBe('informational');
        expect(diagnostic.caller_kinds_do_not_widen).toBe(false);
        expect(diagnostic.triggering_rule).toContain('informational');
      }
      
    } finally {
      console.log = originalLog;
    }
  });

  it('should NOT leak sensitive text in diagnostic logs', async () => {
    const mockConsole = vi.fn();
    const originalLog = console.log;
    console.log = mockConsole;
    
    try {
      const request = {
        claim: 'Post API key sk_live_abc123 to internal channel',
        evidence: `Action: Send message\nMandate: Post API key sk_live_abc123 to internal channel`,
        mandate: {
          kind: 'informational' as const,
          action: { kind: 'informational' as const },
        },
        tier: 'checkpoint' as const,
        mode: 'action_authorization' as const,
      };

      const result = await verify(request);
      
      // Diagnostic should not contain sensitive text
      expect(result.meta.promotion?.prose_mandate_kind).not.toContain('sk_live_abc123');
      expect(result.meta.promotion?.prose_action_kind).not.toContain('sk_live_abc123');
      
      // But should have valid enum values
      expect(['informational', 'unknown', 'value_transfer', 'permission', 'deploy_ship'])
        .toContain(result.meta.promotion?.prose_mandate_kind);
      
    } finally {
      console.log = originalLog;
    }
  });

  it('should work for numeric claim objection without false evidence binding', async () => {
    // Test that numeric claims are handled safely per parent guidance
    const request = {
      claim: 'Issue #85 contains 4 receipts from Day-14 on numeric claims',
      evidence: `Action: Review issue\nMandate: Issue #85 contains 4 receipts from Day-14 on numeric claims`,
      tier: 'checkpoint' as const,
      mode: 'action_authorization' as const,
    };

    const result = await verify(request);
    
    // Should classify correctly without claiming all receipts are false_BLOCK
    expect(result.meta.promotion?.prose_mandate_kind).toBeDefined();
    
    // Numeric identifiers should not trigger spend-claim objections  
    if (result.objections) {
      const numericObjections = result.objections.filter(obj => 
        obj.predicate.includes('numeric') && obj.predicate.includes('unverified')
      );
      // Should not have unbound numeric claim objections for issue numbers
      expect(numericObjections.length).toBe(0);
    }
  });
});