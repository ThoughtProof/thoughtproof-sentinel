import { generateKeyPairSync, sign, createPublicKey, verify, createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import canonicalize from 'canonicalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'fixtures', 'f5');
mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ type: 'spki', format: 'der' });
const pubHex = Buffer.from(der).subarray(12).toString('hex');

const payload = { action: 'transfer', amount: 500, currency: 'USD', to: 'acct_demo' };
const canonical = canonicalize(payload);
const sig = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
const raw_event = Buffer.from(JSON.stringify({ payload, signature: sig }), 'utf8').toString('base64');
const forged_raw = Buffer.from(JSON.stringify({ payload, signature: '00'.repeat(64) }), 'utf8').toString('base64');

const derHeader = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const pem = [
  '-----BEGIN PUBLIC KEY-----',
  Buffer.concat([derHeader, Buffer.from(pubHex, 'hex')]).toString('base64').match(/.{1,64}/g).join('\n'),
  '-----END PUBLIC KEY-----',
].join('\n');
const ok = verify(null, Buffer.from(canonical, 'utf8'), createPublicKey(pem), Buffer.from(sig, 'hex'));
if (!ok) throw new Error('fixture self-verify failed');

function packageDigest(req) {
  return 'sha256:' + createHash('sha256').update(canonicalize(req), 'utf8').digest('hex');
}

const requestValid = {
  claim: 'Agent decided to transfer funds',
  evidence: 'Policy requires approval for transfers > $1000. Transfer amount: $500.',
  mode: 'handoff',
  tier: 'standard',
  signed_evidence: [{
    type: 'signed_event',
    raw_event,
    signature_scheme: 'ed25519',
    signer_pubkey: pubHex,
    claims: ['owner_signoff'],
    verification: 'required',
  }],
};

const requestForged = {
  ...requestValid,
  signed_evidence: [{
    type: 'signed_event',
    raw_event: forged_raw,
    signature_scheme: 'ed25519',
    signer_pubkey: pubHex,
    claims: ['owner_signoff'],
    verification: 'required',
  }],
};

const receiptValid = {
  id: 'sent_f5_valid',
  verdict: 'ALLOW',
  confidence: 90,
  tier: 'standard',
  mode: 'handoff',
  meta: {
    package_digest: packageDigest(requestValid),
    proof_strength: 'recomputed',
    evidence_verification: [{ index: 0, status: 'recomputed', signer: pubHex }],
  },
};

const receiptForged = {
  id: 'sent_f5_forged',
  verdict: 'ALLOW',
  confidence: 90,
  tier: 'standard',
  mode: 'handoff',
  meta: {
    package_digest: packageDigest(requestForged),
    proof_strength: 'recomputed',
    evidence_verification: [{ index: 0, status: 'recomputed', signer: pubHex }],
  },
};

writeFileSync(join(outDir, 'pubkey.txt'), pubHex + '\n');
writeFileSync(join(outDir, 'request-valid.json'), JSON.stringify(requestValid, null, 2) + '\n');
writeFileSync(join(outDir, 'request-forged.json'), JSON.stringify(requestForged, null, 2) + '\n');
writeFileSync(join(outDir, 'receipt-valid.json'), JSON.stringify(receiptValid, null, 2) + '\n');
writeFileSync(join(outDir, 'receipt-forged.json'), JSON.stringify(receiptForged, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, pubPrefix: pubHex.slice(0, 16), outDir }));
