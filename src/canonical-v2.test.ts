import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as canonicalVerdict from './canonical-verdict.js';
import {
  clearExportSignerReadinessCache,
  generateExportKeyPair,
  issueSignedCanonicalExport,
  maybeIssueSignedExport,
  maybeIssueSignedExportV2,
  verifySignedCanonicalExport,
} from './canonical-export.js';
import { getPotCliVersion } from './runtime-versions.js';
import type { SentinelVerifyResponse } from './types.js';

const {
  buildCanonicalSentinelVerdict,
  buildCanonicalSentinelVerdictV2,
  hashCanonicalSentinelVerdict,
  serializeCanonicalSentinelVerdict,
} = canonicalVerdict;

const FIXTURE_JCS =
  '{"apiVersion":"sentinel-api-0.1.0","artifactSchema":"sentinel.verdict.canonical.v1","confidence":84,"evaluatedAt":1782916498,"mode":"trade_execution","models":{"primary":"serv-nano","secondary":"serv-swift"},"objections":["step_0: Direction claim verified against market data."],"reasoning":"All steps adequately supported by the evidence.","tier":"standard","verdict":"ALLOW","verificationId":"sent_9f3c2a7b1e004d68"}';

const V1_SIGNATURE =
  '0x81aa38bdde6c519a8c8029fedca2a5848a348dbfbc1e1a377864eef3e440f133631da5dc3c01e9716ac9745fda8296261b4f9546de80bf29748777f4a1fc9c00';

const RELEASE_ID = 'da6b6378e105d0c7e1f810bbe237d2f23c55c103';
const POLICY =
  'adr-0019-cascade-promotion-2026-08-08+p0-primary-error-fail-closed+p0-objective-mismatch-fail-closed+p0-informational-allowlist+p0-unknown-action-fail-closed+p0-unclassified-abstention-uncertain+p0-caller-declared-kinds';
const POT_CLI = '0.8.12';

function fixtureResponse(
  promotion?: SentinelVerifyResponse['meta']['promotion'],
): SentinelVerifyResponse {
  return {
    id: 'sent_9f3c2a7b1e004d68',
    verdict: 'ALLOW',
    confidence: 0.84,
    reasoning: 'All steps adequately supported by the evidence.',
    objections: [
      {
        step_id: 'step_0',
        criterion: 'Direction check',
        score: 0.9,
        predicate: 'supported',
        quote: null,
        reasoning: 'Direction claim verified against market data.',
      },
    ],
    mode: 'trade_execution',
    tier: 'standard',
    meta: {
      duration_ms: 1200,
      models_used: ['serv-nano', 'serv-swift'],
      verified_at: '2026-07-01T14:34:58.000Z',
      ...(promotion ? { promotion } : {}),
    },
  };
}

function promotion(): NonNullable<SentinelVerifyResponse['meta']['promotion']> {
  return {
    cascade_reason: null,
    internal_verdict: 'ALLOW',
    mapped_verdict: 'ALLOW',
    public_verdict: 'ALLOW',
    promoted: false,
    reason: 'already_allow',
    steps_all_pass: true,
    machine_condition_proof_present: false,
    machine_condition_proof_accepted: false,
    release_id: RELEASE_ID,
    policy: POLICY,
  };
}

function publicFromSeed(seedHex: string): KeyObject {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seedHex, 'hex'),
  ]);
  return createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}

function vectorPublicKey(): KeyObject {
  const doc = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'thoughtproof-keys.json'), 'utf8'),
  ) as { keys: Array<{ kid: string; x: string }> };
  const vector = doc.keys.find((key) => key.kid === 'tp-sentinel-export-ed25519-2026-09-vector');
  if (!vector) throw new Error('vector kid missing');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: vector.x },
    format: 'jwk',
  });
}

function readVector(name: string) {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'scripts', 'fixtures', 'm1-export-v2', name), 'utf8'),
  ) as {
    artifactSchema: string;
    canonical: string;
    digest: string;
    signature: string;
    keyId: string;
  };
}

describe('canonical verdict v2', () => {
  it('keeps the v1 fixture bytes when provenance is present on the response', () => {
    const response = fixtureResponse(promotion());
    const v1 = buildCanonicalSentinelVerdict(response);
    expect(serializeCanonicalSentinelVerdict(v1)).toBe(FIXTURE_JCS);
    expect(v1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
  });

  it('adds releaseId, policy, and potCli and omits them when they are not publishable', () => {
    const withProvenance = buildCanonicalSentinelVerdictV2(fixtureResponse(promotion()), {
      potCli: POT_CLI,
    });
    expect(withProvenance.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(withProvenance.releaseId).toBe(RELEASE_ID);
    expect(withProvenance.policy).toBe(POLICY);
    expect(withProvenance.potCli).toBe(POT_CLI);
    expect(withProvenance.verificationId).toBe('sent_9f3c2a7b1e004d68');
    expect(withProvenance.verdict).toBe('ALLOW');

    const omitted = buildCanonicalSentinelVerdictV2(fixtureResponse(), { potCli: 'unavailable' });
    expect(omitted.releaseId).toBeUndefined();
    expect(omitted.policy).toBeUndefined();
    expect(omitted.potCli).toBeUndefined();
    const parsed = JSON.parse(serializeCanonicalSentinelVerdict(omitted)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('releaseId');
    expect(parsed).not.toHaveProperty('policy');
    expect(parsed).not.toHaveProperty('potCli');
    expect(parsed.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(hashCanonicalSentinelVerdict(omitted)).not.toBe(
      hashCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(fixtureResponse())),
    );
  });

  it('reads the installed pot-cli version when no override is passed', () => {
    const body = buildCanonicalSentinelVerdictV2(fixtureResponse());
    expect(body.potCli).toBe(getPotCliVersion());
  });

  it('copies gate detail into v2 without putting provenance into v1', () => {
    const response = fixtureResponse(promotion());
    response.gate = {
      mode: 'enforce',
      wouldBlock: true,
      enforced: true,
      violations: [{ kind: 'recipient_mismatch', detail: 'recipient mismatch' }],
    };
    const v1 = serializeCanonicalSentinelVerdict(buildCanonicalSentinelVerdict(response));
    const v2 = JSON.parse(
      serializeCanonicalSentinelVerdict(
        buildCanonicalSentinelVerdictV2(response, { potCli: POT_CLI }),
      ),
    ) as { gate: { violations: string[] }; artifactSchema: string; releaseId: string };
    expect(v1).toContain('recipient mismatch');
    expect(v1).not.toContain('releaseId');
    expect(v1).not.toContain('potCli');
    expect(v2.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(v2.releaseId).toBe(RELEASE_ID);
    expect(v2.gate.violations).toEqual(['recipient mismatch']);
  });
});

describe('dual issue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearExportSignerReadinessCache();
  });

  it('signs a response as v1 and a v2 body as v2; both verify', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const response = fixtureResponse(promotion());
    const before = structuredClone(response);
    const v1 = issueSignedCanonicalExport(response, {
      privateKey,
      keyId: 'k',
      nowSeconds: 1_782_916_498,
    });
    const v2 = issueSignedCanonicalExport(
      buildCanonicalSentinelVerdictV2(response, { potCli: POT_CLI }),
      { privateKey, keyId: 'k', nowSeconds: 1_782_916_498 },
    );
    expect(response).toEqual(before);
    expect(response.verdict).toBe('ALLOW');
    expect(v1.canonical).toBe(FIXTURE_JCS);
    expect(v1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(v2.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(v1.digest).not.toBe(v2.digest);
    expect(v1.signedAt).toBe(v2.signedAt);
    expect(verifySignedCanonicalExport(v1, publicKey, { nowSeconds: v1.signedAt }).ok).toBe(true);
    expect(verifySignedCanonicalExport(v2, publicKey, { nowSeconds: v2.signedAt }).ok).toBe(true);
  });

  it('rejects an artifact schema other than v1 or v2', () => {
    const { privateKey, publicKey } = generateExportKeyPair();
    const exp = issueSignedCanonicalExport(fixtureResponse(), {
      privateKey,
      keyId: 'k',
      nowSeconds: 10,
    });
    const unknown = { ...exp, artifactSchema: 'sentinel.verdict.canonical.v9' };
    const result = verifySignedCanonicalExport(unknown, publicKey, { nowSeconds: 10 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('schema_unsupported');
  });

  it('issues both exports from env and omits only v2 when the v2 body throws', () => {
    const seed = 'ab'.repeat(32);
    const env = {
      SENTINEL_EXPORT_PRIVATE_KEY: seed,
      SENTINEL_EXPORT_KEY_ID: 'v2-test-kid',
    };
    const response = fixtureResponse(promotion());
    clearExportSignerReadinessCache();
    const load = { requirePublishedMatch: false as const };
    const v1 = maybeIssueSignedExport(response, env, 1_782_916_498, load);
    const v2 = maybeIssueSignedExportV2(response, env, 1_782_916_498, load);
    const pub = publicFromSeed(seed);
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v1!.canonical).toBe(FIXTURE_JCS);
    expect(response.verdict).toBe('ALLOW');
    expect(verifySignedCanonicalExport(v1!, pub, { nowSeconds: 1_782_916_498 }).ok).toBe(true);
    expect(verifySignedCanonicalExport(v2!, pub, { nowSeconds: 1_782_916_498 }).ok).toBe(true);
    expect(JSON.parse(v2!.canonical).potCli).toBe(getPotCliVersion());

    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(canonicalVerdict, 'buildCanonicalSentinelVerdictV2').mockImplementation(() => {
      throw new Error('v2 provenance unavailable');
    });
    clearExportSignerReadinessCache();
    const v1Again = maybeIssueSignedExport(response, env, 1_782_916_498, load);
    const v2Omitted = maybeIssueSignedExportV2(response, env, 1_782_916_498, load);
    expect(v1Again).not.toBeNull();
    expect(v1Again!.canonical).toBe(FIXTURE_JCS);
    expect(v1Again!.signature).toBe(v1!.signature);
    expect(v2Omitted).toBeNull();
    expect(response.verdict).toBe('ALLOW');
    const logText = logged.flat().map((part) => String(part)).join(' ');
    expect(logText).toContain('omitting signed_export_v2');
    expect(logText).not.toContain(seed);
    expect(logText).not.toContain('All steps adequately supported');
  });
});

describe('v2 vectors', () => {
  const pub = vectorPublicKey();

  it('leaves the committed v1 vector signature unchanged', () => {
    const v1 = JSON.parse(
      readFileSync(join(process.cwd(), 'scripts', 'fixtures', 'm1-export', 'export-valid.json'), 'utf8'),
    ) as { canonical: string; digest: string; signature: string; artifactSchema: string };
    expect(v1.artifactSchema).toBe('sentinel.verdict.canonical.v1');
    expect(v1.canonical).toBe(FIXTURE_JCS);
    expect(v1.digest).toBe(
      '0x419c360db82ee72be3411acd2d30f560b3f62842c2162fa3cb4a08c1fa4ce65a',
    );
    expect(v1.signature).toBe(V1_SIGNATURE);
    expect(verifySignedCanonicalExport(v1, pub, { nowSeconds: 1782916498 }).ok).toBe(true);
  });

  it('matches the generator bytes and verifies v1 and v2 fixtures', () => {
    const valid = readVector('export-v2-valid.json');
    const omitted = readVector('export-v2-omitted-optionals.json');
    const tampered = readVector('export-v2-tampered-canonical.json');

    const rebuilt = serializeCanonicalSentinelVerdict(
      buildCanonicalSentinelVerdictV2(fixtureResponse(promotion()), { potCli: POT_CLI }),
    );
    const rebuiltOmitted = serializeCanonicalSentinelVerdict(
      buildCanonicalSentinelVerdictV2(fixtureResponse(), { potCli: 'unavailable' }),
    );
    expect(valid.canonical).toBe(rebuilt);
    expect(omitted.canonical).toBe(rebuiltOmitted);
    expect(valid.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(omitted.artifactSchema).toBe('sentinel.verdict.canonical.v2');
    expect(valid.digest).not.toBe(omitted.digest);

    expect(verifySignedCanonicalExport(valid, pub, { nowSeconds: 1782916498 }).ok).toBe(true);
    expect(verifySignedCanonicalExport(omitted, pub, { nowSeconds: 1782916498 }).ok).toBe(true);
    const tamper = verifySignedCanonicalExport(tampered, pub, { nowSeconds: 1782916498 });
    expect(tamper.ok).toBe(false);
    expect(tamper.code).toBe('signature_invalid');

    const script = (file: string) =>
      spawnSync(process.execPath, [
        'scripts/verify-canonical-export.mjs',
        file,
        '--keys',
        'data/thoughtproof-keys.json',
        '--now',
        '1782916498',
        '--allow-vector-only',
      ], { encoding: 'utf8' });

    const v1 = script('scripts/fixtures/m1-export/export-valid.json');
    expect(v1.status).toBe(0);
    expect(JSON.parse(v1.stdout).ok).toBe(true);

    const v2 = script('scripts/fixtures/m1-export-v2/export-v2-valid.json');
    expect(v2.status).toBe(0);
    expect(JSON.parse(v2.stdout).ok).toBe(true);

    const v2Omit = script('scripts/fixtures/m1-export-v2/export-v2-omitted-optionals.json');
    expect(v2Omit.status).toBe(0);

    const v2Bad = script('scripts/fixtures/m1-export-v2/export-v2-tampered-canonical.json');
    expect(v2Bad.status).not.toBe(0);
  });
});
