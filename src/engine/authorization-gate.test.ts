import { describe, it, expect } from 'vitest';
import { runAuthorizationGate, type AuthorizationMandate } from './authorization-gate.js';

describe('runAuthorizationGate — fail toward silence', () => {
  it('is silent when no mandate is supplied', () => {
    const r = runAuthorizationGate(undefined, 'enforce');
    expect(r.silent).toBe(true);
    expect(r.wouldBlock).toBe(false);
    expect(r.enforcedVerdict).toBeNull();
  });

  it('is silent when mandate has neither granted nor action', () => {
    const r = runAuthorizationGate({}, 'enforce');
    expect(r.silent).toBe(true);
    expect(r.wouldBlock).toBe(false);
  });

  it('is silent on a clean exact-scope action (no violation)', () => {
    const m: AuthorizationMandate = {
      granted: { maxAmount: 200, recipient: '0xACME', asset: 'USDC' },
      action: { amount: 200, recipient: '0xACME', asset: 'USDC' },
    };
    const r = runAuthorizationGate(m, 'enforce');
    expect(r.silent).toBe(false);
    expect(r.wouldBlock).toBe(false);
    expect(r.violations).toHaveLength(0);
    expect(r.enforcedVerdict).toBeNull();
  });

  it('does not flag amount overshoot when granted amount is missing (silence on that check)', () => {
    const m: AuthorizationMandate = {
      granted: { recipient: '0xACME' },
      action: { amount: 999999, recipient: '0xACME' },
    };
    const r = runAuthorizationGate(m, 'enforce');
    expect(r.violations.some((v) => v.kind === 'amount_overshoot')).toBe(false);
  });
});

describe('runAuthorizationGate — amount overshoot (the arithmetic vector)', () => {
  const m: AuthorizationMandate = {
    granted: { maxAmount: 200, recipient: '0xACME1234', asset: 'USDC' },
    action: { amount: 2000, recipient: '0xACME1234', asset: 'USDC' },
  };

  it('detects a 10x overshoot deterministically', () => {
    const r = runAuthorizationGate(m, 'shadow');
    expect(r.wouldBlock).toBe(true);
    expect(r.violations.map((v) => v.kind)).toContain('amount_overshoot');
  });

  it('does NOT gate in shadow mode (enforcedVerdict null)', () => {
    const r = runAuthorizationGate(m, 'shadow');
    expect(r.enforcedVerdict).toBeNull();
  });

  it('BLOCKs in enforce mode', () => {
    const r = runAuthorizationGate(m, 'enforce');
    expect(r.enforcedVerdict).toBe('BLOCK');
  });

  it('allows the action exactly at the granted amount', () => {
    const exact: AuthorizationMandate = {
      granted: { maxAmount: 200 },
      action: { amount: 200 },
    };
    expect(runAuthorizationGate(exact, 'enforce').wouldBlock).toBe(false);
  });

  it('tolerates a tiny rounding overage within tolerance', () => {
    const fee: AuthorizationMandate = {
      granted: { maxAmount: 200 },
      action: { amount: 200.5 }, // 0.25% over, under 0.5% tolerance
    };
    expect(runAuthorizationGate(fee, 'enforce').wouldBlock).toBe(false);
  });

  it('blocks just above the tolerance ceiling', () => {
    const over: AuthorizationMandate = {
      granted: { maxAmount: 200 },
      action: { amount: 202 }, // 1% over, beyond 0.5% tolerance
    };
    expect(runAuthorizationGate(over, 'enforce').wouldBlock).toBe(true);
  });
});

describe('runAuthorizationGate — recipient mismatch', () => {
  it('blocks a recipient that differs from the mandate', () => {
    const m: AuthorizationMandate = {
      granted: { recipient: '0xACME1234' },
      action: { recipient: '0xBAD9999' },
    };
    const r = runAuthorizationGate(m, 'enforce');
    expect(r.wouldBlock).toBe(true);
    expect(r.violations.map((v) => v.kind)).toContain('recipient_mismatch');
  });

  it('is case-insensitive on addresses', () => {
    const m: AuthorizationMandate = {
      granted: { recipient: '0xAbCdEf' },
      action: { recipient: '0xabcdef' },
    };
    expect(runAuthorizationGate(m, 'enforce').wouldBlock).toBe(false);
  });
});

describe('runAuthorizationGate — unlimited approval', () => {
  it('blocks MAX_UINT256 string allowance when not granted', () => {
    const m: AuthorizationMandate = {
      granted: { maxAmount: 200, allowUnlimited: false },
      action: { allowance: 'MAX_UINT256' },
    };
    const r = runAuthorizationGate(m, 'enforce');
    expect(r.wouldBlock).toBe(true);
    expect(r.violations.map((v) => v.kind)).toContain('unlimited_approval');
  });

  it('blocks a 64-f hex allowance', () => {
    const m: AuthorizationMandate = {
      granted: {},
      action: { allowance: '0x' + 'f'.repeat(64) },
    };
    expect(runAuthorizationGate(m, 'enforce').wouldBlock).toBe(true);
  });

  it('blocks a huge numeric allowance', () => {
    const m: AuthorizationMandate = {
      granted: {},
      action: { allowance: 1e40 },
    };
    expect(runAuthorizationGate(m, 'enforce').wouldBlock).toBe(true);
  });

  it('allows unlimited when the principal explicitly granted it', () => {
    const m: AuthorizationMandate = {
      granted: { allowUnlimited: true },
      action: { allowance: 'unlimited' },
    };
    expect(runAuthorizationGate(m, 'enforce').wouldBlock).toBe(false);
  });

  it('allows a bounded exact-amount allowance', () => {
    const m: AuthorizationMandate = {
      granted: { maxAmount: 200 },
      action: { allowance: 200 },
    };
    expect(runAuthorizationGate(m, 'enforce').wouldBlock).toBe(false);
  });

  it('is silent on an unparseable allowance string', () => {
    const m: AuthorizationMandate = {
      granted: {},
      action: { allowance: 'lots' },
    };
    expect(runAuthorizationGate(m, 'enforce').wouldBlock).toBe(false);
  });
});

describe('runAuthorizationGate — multiple violations', () => {
  it('collects all hard violations at once', () => {
    const m: AuthorizationMandate = {
      granted: { maxAmount: 200, recipient: '0xACME', allowUnlimited: false },
      action: { amount: 5000, recipient: '0xBAD', allowance: 'MAX_UINT256' },
    };
    const r = runAuthorizationGate(m, 'enforce');
    const kinds = r.violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(['amount_overshoot', 'recipient_mismatch', 'unlimited_approval']);
    expect(r.enforcedVerdict).toBe('BLOCK');
  });
});
