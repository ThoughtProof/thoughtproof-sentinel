/**
 * Regression tests for Issue #85 - Prove diagnostic logging works
 */
import { describe, it, expect } from 'vitest';
import { classifyActionAuthKind } from './action-auth-kind.js';

describe('Issue #85: Diagnostic logging regression', () => {

  it('should include caller diagnostic metadata', () => {
    const result = classifyActionAuthKind(
      'Send $100 to wallet 0x123',
      'Action: Process transfer\nMandate: Send $100 to wallet 0x123',
      {
        kind: 'informational' as const, // Caller declares informational but prose suggests value_transfer
        action: { kind: 'informational' as const },
      }
    );

    // Should have caller diagnostic
    expect(result.caller_kinds_diagnostic).toBeDefined();
    expect(result.caller_kinds_diagnostic?.caller_mandate_kind).toBe('informational');
    expect(result.caller_kinds_diagnostic?.caller_action_kind).toBe('informational');

    // Should detect prose as value_transfer (contains "$100")
    expect(result.prose_mandate_kind).toBe('value_transfer');
    expect(result.prose_action_kind).toBe('value_transfer');

    // Should block caller widening attempt
    expect(result.caller_kinds_diagnostic?.caller_kinds_do_not_widen).toBe(false);
    expect(result.caller_kinds_diagnostic?.triggering_rule).toBe('callerDeclaredKindsDoNotWiden');
  });

  it('should NOT expose sensitive text in diagnostic metadata', () => {
    const result = classifyActionAuthKind(
      'Post API key sk_live_abc123 to channel',
      'Action: Send message\nMandate: Post API key sk_live_abc123 to channel'
    );

    // Prose kinds should be enum values, not contain sensitive data
    expect(['informational', 'unknown', 'value_transfer', 'permission', 'deploy_ship'])
      .toContain(result.prose_mandate_kind);
    expect(['informational', 'unknown', 'value_transfer', 'permission', 'deploy_ship'])
      .toContain(result.prose_action_kind);

    // Should not leak sensitive text
    expect(result.prose_mandate_kind).not.toContain('sk_live_abc123');
    expect(result.prose_action_kind).not.toContain('sk_live_abc123');
  });

  it('should handle numeric identifiers without false spend claims', () => {
    const result = classifyActionAuthKind(
      'Review issue #85 with Day-14 receipts',
      'Action: Post review\nMandate: Review issue #85 with Day-14 receipts'
    );

    // Should classify based on action, not get confused by numbers
    expect(result.prose_mandate_kind).toBeDefined();
    expect(result.prose_action_kind).toBeDefined();

    // Should not treat issue numbers as spend amounts
    expect(result.prose_mandate_kind).not.toBe('value_transfer');
  });
});
