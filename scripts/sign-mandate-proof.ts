#!/usr/bin/env node
/**
 * Sign one verify request body's mandate as ADR-0023 `mandate_proof`.
 *
 * The private key is read from SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH.
 * It is not an argument. A failure writes nothing to stdout.
 *
 *   SENTINEL_PRINCIPAL_PRIVATE_KEY_PATH=./principal.pem \
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/register-ts-extension.mjs \
 *     scripts/sign-mandate-proof.ts \
 *     --body ./request.json \
 *     --account-id <account-id> \
 *     --kid <principal_kid> \
 *     --environment production
 *
 * Optional: --nonce, --iat, --exp, --now (unix seconds).
 * Exit 0 prints the proof. Exit 2 prints a fixed stderr line and no proof.
 * This script does not pin a key and does not change server configuration.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { signMandateProofCli } from '../src/sign-mandate-proof.js';

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = signMandateProofCli({
    argv: process.argv.slice(2),
    env: process.env,
  });
  process.exit(code);
}
