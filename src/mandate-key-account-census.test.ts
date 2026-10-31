/**
 * Read-only proof: every API key maps to one account, including rotation
 * overlap and revoked keys. No-auth requests under enforce are not ALLOW.
 * The count script is exercised on local fixtures only.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSentinelApiKeyRecords } from './server-account.js';
import { evaluateMandateRequestPath } from './mandate-request-path.js';
import {
  censusSentinelApiKeys,
  inspectKeyMapping,
  isPublicCensusReport,
  keysShareOneAccount,
  type KeyAccountCensus,
} from './mandate-key-account-census.js';

const OLD_KEY = 'sk_census_old';
const NEW_KEY = 'sk_census_new';
const OTHER_KEY = 'sk_census_other';
const ACCOUNT = 'acct-census';
const OTHER = 'acct-census-other';

const OVERLAP = `${OLD_KEY}:direct:agent-old:${ACCOUNT},${NEW_KEY}:direct:agent-new:${ACCOUNT}`;
const SCRIPT = fileURLToPath(new URL('../scripts/mandate-key-account-census.ts', import.meta.url));

function expectNoMaterial(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain(OLD_KEY);
  expect(json).not.toContain(NEW_KEY);
  expect(json).not.toContain(OTHER_KEY);
  expect(json).not.toContain(ACCOUNT);
  expect(json).not.toContain(OTHER);
  expect(json).not.toContain('ALLOW');
  expect(json).not.toContain('agent-old');
  expect(json).not.toContain('agent-new');
}

describe('key to account census', () => {
  it('proves rotation overlap maps both keys to one account', () => {
    const report = censusSentinelApiKeys(OVERLAP);
    expect(report).toEqual({
      deterministic: true,
      authorizes_execution: false,
      records: 2,
      distinct_keys: 2,
      mapped_keys: 2,
      unmapped_keys: 0,
      ambiguous_keys: 0,
      empty_keys: 0,
      distinct_accounts: 1,
      overlap_accounts: 1,
      rotation_overlap_keys: 2,
      revoked_keys: 0,
      revoked_absent: 0,
      revoked_ambiguous: 0,
      revoked_unmapped: 0,
      duplicate_rows: 0,
    } satisfies KeyAccountCensus);
    expect(keysShareOneAccount(OVERLAP, [OLD_KEY, NEW_KEY])).toBe(true);
    expect(inspectKeyMapping(OVERLAP, OLD_KEY)).toEqual({
      maps: true,
      revoked: false,
      authorizesExecution: false,
    });
    expect(inspectKeyMapping(OVERLAP, NEW_KEY).authorizesExecution).toBe(false);
    expectNoMaterial(report);
  });

  it('keeps a revoked key on exactly one account and does not authorize it', () => {
    const report = censusSentinelApiKeys(OVERLAP, [OLD_KEY]);
    expect(report.deterministic).toBe(true);
    expect(report.revoked_keys).toBe(1);
    expect(report.revoked_absent).toBe(0);
    expect(report.overlap_accounts).toBe(1);
    expect(report.authorizes_execution).toBe(false);
    expect(inspectKeyMapping(OVERLAP, OLD_KEY, [OLD_KEY])).toEqual({
      maps: true,
      revoked: true,
      authorizesExecution: false,
    });
    expect(inspectKeyMapping(OVERLAP, NEW_KEY, [OLD_KEY])).toEqual({
      maps: true,
      revoked: false,
      authorizesExecution: false,
    });
    expect(keysShareOneAccount(OVERLAP, [OLD_KEY, NEW_KEY], [OLD_KEY])).toBe(true);

    const absent = censusSentinelApiKeys(OVERLAP, [OTHER_KEY]);
    expect(absent.deterministic).toBe(true);
    expect(absent.revoked_keys).toBe(0);
    expect(absent.revoked_absent).toBe(1);
    expectNoMaterial(report);
    expectNoMaterial(absent);
  });

  it('fails closed when one key has two accounts, no account, or a revoked conflict', () => {
    const ambiguous = `${OLD_KEY}:direct:agent-old:${ACCOUNT},${OLD_KEY}:direct:agent-old:${OTHER}`;
    const ambiguousReport = censusSentinelApiKeys(ambiguous);
    expect(ambiguousReport.deterministic).toBe(false);
    expect(ambiguousReport.ambiguous_keys).toBe(1);
    expect(ambiguousReport.mapped_keys).toBe(0);
    expect(ambiguousReport.distinct_accounts).toBe(2);
    expect(inspectKeyMapping(ambiguous, OLD_KEY)).toEqual({
      maps: false,
      code: 'AMBIGUOUS',
      revoked: false,
      authorizesExecution: false,
    });
    expect(keysShareOneAccount(ambiguous, [OLD_KEY, OLD_KEY])).toBe(false);

    const unmapped = `${OLD_KEY}:direct:agent-old,${NEW_KEY}:direct:agent-new:${ACCOUNT}`;
    const unmappedReport = censusSentinelApiKeys(unmapped);
    expect(unmappedReport.deterministic).toBe(false);
    expect(unmappedReport.unmapped_keys).toBe(1);
    expect(unmappedReport.mapped_keys).toBe(1);
    expect(inspectKeyMapping(unmapped, OLD_KEY).maps).toBe(false);
    if (!inspectKeyMapping(unmapped, OLD_KEY).maps) {
      expect(inspectKeyMapping(unmapped, OLD_KEY)).toMatchObject({ code: 'UNMAPPED' });
    }

    const revokedConflict = censusSentinelApiKeys(ambiguous, [OLD_KEY]);
    expect(revokedConflict.deterministic).toBe(false);
    expect(revokedConflict.revoked_ambiguous).toBe(1);
    expect(inspectKeyMapping(ambiguous, OLD_KEY, [OLD_KEY])).toMatchObject({
      maps: false,
      code: 'AMBIGUOUS',
      revoked: true,
      authorizesExecution: false,
    });

    const duplicate = `${OLD_KEY}:direct:agent-old:${ACCOUNT},${OLD_KEY}:acp:agent-old:${ACCOUNT}`;
    const duplicateReport = censusSentinelApiKeys(duplicate);
    expect(duplicateReport.deterministic).toBe(true);
    expect(duplicateReport.duplicate_rows).toBe(1);
    expect(duplicateReport.distinct_keys).toBe(1);
    expect(duplicateReport.mapped_keys).toBe(1);

    expect(censusSentinelApiKeys('').deterministic).toBe(false);
    expect(censusSentinelApiKeys('').records).toBe(0);
    expect(censusSentinelApiKeys(undefined).deterministic).toBe(false);
    expect(censusSentinelApiKeys(OVERLAP, null as unknown as string[]).records).toBe(0);
    expect(censusSentinelApiKeys(OVERLAP, [1] as unknown as string[]).deterministic).toBe(false);
    const missing = inspectKeyMapping(OVERLAP, '');
    expect(missing.maps).toBe(false);
    if (!missing.maps) expect(missing.code).toBe('MISSING_KEY');
    const blank = inspectKeyMapping(OVERLAP, '   ');
    expect(blank.maps).toBe(false);
    if (!blank.maps) expect(blank.code).toBe('MISSING_KEY');
    expectNoMaterial(ambiguousReport);
    expectNoMaterial(unmappedReport);
    expectNoMaterial(revokedConflict);
  });

  it('matches the server record parser on counts, including a colon in the account id', () => {
    const samples = [
      OVERLAP,
      `${OLD_KEY}:direct:agent-old:${ACCOUNT}:${OTHER}`,
      `${OLD_KEY}:openserv:agent-old`,
      `${OLD_KEY}:direct:agent-old:${ACCOUNT},,${NEW_KEY}:acp:agent-new:${OTHER}`,
      `:direct:agent-old:${ACCOUNT}`,
      '',
    ];
    for (const raw of samples) {
      const official = parseSentinelApiKeyRecords(raw);
      expect(official).not.toBeNull();
      const report = censusSentinelApiKeys(raw);
      expect(report.records).toBe(official?.length);
      const accounts = new Set(
        (official ?? []).map((record) => record.accountId).filter((id) => id && id.length > 0),
      );
      expect(report.distinct_accounts).toBe(accounts.size);
      expect(isPublicCensusReport(report)).toBe(true);
      expect(report.authorizes_execution).toBe(false);
    }
  });

  it('fails closed for a request with no key while enforce evaluation runs', async () => {
    const deps = {
      nowSeconds: () => 1_800_000_000,
      readPolicy: () => 'legacy' as const,
      manifestStore: null,
      env: { SENTINEL_API_KEYS: OVERLAP },
    };
    const body = { claim: 'status', evidence: 'note', mode: 'handoff' };
    const open = await evaluateMandateRequestPath({
      authRequired: false,
      apiKey: '',
      accountIdFromAuth: undefined,
      body,
      requestId: 'req_census_open',
      deps,
    });
    expect(open.action).toBe('unavailable');
    if (open.action === 'unavailable') {
      expect(open.status).toBe(503);
      expect(open.body.code).toBe('ACCOUNT_UNAVAILABLE');
      expect(open.body).not.toHaveProperty('verdict');
    }
    expect(open.action).not.toBe('continue');

    const required = await evaluateMandateRequestPath({
      authRequired: true,
      apiKey: '',
      accountIdFromAuth: undefined,
      body,
      requestId: 'req_census_required',
      deps,
    });
    expect(required).toEqual({ action: 'unauthorized' });
    expect(JSON.stringify(open)).not.toContain('ALLOW');
    expect(JSON.stringify(required)).not.toContain('ALLOW');
    expect(JSON.stringify(open)).not.toContain(OLD_KEY);
    expect(JSON.stringify(required)).not.toContain(ACCOUNT);
  });
});

describe('mandate key account census script', () => {
  it('prints aggregate counts for a local fixture and not the records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-census-'));
    const keysPath = join(dir, 'keys.txt');
    const revokedPath = join(dir, 'revoked.txt');
    const missingPath = join(dir, 'sk_path_secret_fixture.txt');
    try {
      writeFileSync(keysPath, OVERLAP);
      writeFileSync(revokedPath, `${OLD_KEY}\n`);
      const ran = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          SCRIPT,
          '--file',
          keysPath,
          '--revoked',
          revokedPath,
        ],
        { encoding: 'utf8' },
      );
      expect(ran.status).toBe(0);
      const report = JSON.parse(ran.stdout) as KeyAccountCensus;
      expect(report).toEqual(censusSentinelApiKeys(OVERLAP, [OLD_KEY]));
      expect(isPublicCensusReport(report)).toBe(true);
      expect(report.authorizes_execution).toBe(false);
      expect(ran.stdout).not.toContain(OLD_KEY);
      expect(ran.stdout).not.toContain(NEW_KEY);
      expect(ran.stdout).not.toContain(ACCOUNT);
      expect(ran.stderr).not.toContain(OLD_KEY);
      expect(ran.stderr).not.toContain(ACCOUNT);

      const fromEnv = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          SCRIPT,
          '--from-env',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SENTINEL_API_KEYS: OVERLAP },
        },
      );
      expect(fromEnv.status).toBe(0);
      expect(JSON.parse(fromEnv.stdout)).toEqual(censusSentinelApiKeys(OVERLAP));
      expect(fromEnv.stdout).not.toContain(OLD_KEY);
      expect(fromEnv.stderr).not.toContain(OLD_KEY);

      const missing = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          SCRIPT,
          '--file',
          missingPath,
        ],
        { encoding: 'utf8' },
      );
      expect(missing.status).toBe(2);
      expect(missing.stdout).toContain('"error":"unreadable"');
      expect(missing.stdout).not.toContain('sk_path_secret_fixture');
      expect(missing.stderr).not.toContain('sk_path_secret_fixture');
      expect(missing.stdout).not.toContain(OLD_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not read the verify handler or the enforce flag', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toContain('SENTINEL_MANDATE_PROOF_ENFORCE');
    expect(source).not.toContain('registerPrincipalKey');
    expect(source).not.toContain('pinPrincipalKeyAsAdmin');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('parseCensusRecords');
    expect(source).not.toContain('[skip ci]');
  });
});
