/**
 * Tests for Issue #85: Logging diagnostics in receipts
 */
import { describe, it, expect } from 'vitest';
import { classifyActionAuthKind, callerDeclaredKindsDoNotWiden } from './action-auth-kind.js';

describe('Issue #85: Receipt logging diagnostics', () => {
  it('should include prose_mandate_kind and prose_action_kind in result', () => {
    const result = classifyActionAuthKind(
      'Post agenda to team channel',
      'Action: Post message\nMandate: Post agenda to team channel',
      {
        kind: 'informational' as const,
        action: { kind: 'informational' as const },
        context: { outcome: 'post' }
      }
    );

    // Should expose prose kinds for logging
    expect(result.prose_mandate_kind).toBeDefined();
    expect(result.prose_action_kind).toBeDefined();
    expect(typeof result.prose_mandate_kind).toBe('string');
    expect(typeof result.prose_action_kind).toBe('string');
  });

  it('should log callerDeclaredKindsDoNotWiden triggering details', () => {
    const context = {
      proseActionKind: 'unknown' as const,
      proseMandateKind: 'unknown' as const,
      actionKindSource: 'caller' as const,
      mandateKindSource: 'caller' as const,
      actionText: 'Post message',
      mandateText: 'Post agenda with settlement info',
      mandate: { context: { outcome: 'post' } },
      boundedPermissionCompatible: false,
      requestedFyiCompatible: false,
    };

    const widens = callerDeclaredKindsDoNotWiden(
      'informational',
      'informational',
      context
    );

    // Should return false (blocks) when caller informational but prose is unknown
    expect(widens).toBe(false);
  });

  it('should provide diagnostic info without exposing sensitive text', () => {
    const result = classifyActionAuthKind(
      'Post private API key abc123 to channel',
      'Action: Send message\nMandate: Post private API key abc123 to channel'
    );

    // Diagnostic info should not contain full text
    expect(result.prose_mandate_kind).not.toContain('abc123');
    expect(result.prose_action_kind).not.toContain('abc123');
    
    // But should have classification
    expect(['informational', 'unknown', 'value_transfer', 'permission', 'deploy_ship'])
      .toContain(result.prose_mandate_kind);
    expect(['informational', 'unknown', 'value_transfer', 'permission', 'deploy_ship'])
      .toContain(result.prose_action_kind);
  });

  it('should include triggering rule diagnostics', () => {
    const result = classifyActionAuthKind(
      'Send $100 to wallet 0x123',
      'Action: Process transfer\nMandate: Send $100 to wallet 0x123',
      {
        kind: 'informational' as const, // Caller claims informational
        action: { kind: 'informational' as const },
        context: { outcome: 'transfer' }
      }
    );

    // Should have diagnostic about caller kinds
    expect(result.caller_kinds_diagnostic).toBeDefined();
    if (result.caller_kinds_diagnostic) {
      expect(result.caller_kinds_diagnostic.caller_mandate_kind).toBe('informational');
      expect(result.caller_kinds_diagnostic.caller_action_kind).toBe('informational');
    }
  });
});