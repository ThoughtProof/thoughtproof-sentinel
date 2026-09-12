#!/usr/bin/env node
/**
 * Byte-level SRI check for ThoughtProof Sentinel docs CDN pins.
 *
 * Imports DOCS_CDN from src/openapi-docs.ts (source of truth), GETs each
 * unpkg URL (follows redirects), computes sha384-<base64>, and compares
 * to the pinned integrity. A mismatch or non-200 fails loudly so a stale
 * hash cannot leave /docs or /redoc empty while CI stays green.
 *
 * Nightly / workflow_dispatch only — not PR CI (unpkg flake).
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     scripts/verify-docs-cdn-sri.ts
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     scripts/verify-docs-cdn-sri.ts --print
 *
 * Re-bump pins: run --print (or openssl dgst -sha384 -binary <file> | openssl base64 -A),
 * then update versions + integrity in DOCS_CDN.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DOCS_CDN } from '../src/openapi-docs.ts';

export const REQUIRED_DOCS_CDN_ASSETS = ['swaggerCss', 'swaggerBundle', 'redoc'] as const;

export const DOCS_SRI_USER_AGENT =
  'thoughtproof-sentinel-docs-sri (+https://github.com/ThoughtProof/thoughtproof-sentinel)';

export type DocsCdnAsset = {
  name: string;
  href: string;
  integrity: string;
};

export type AssetCheckOk = {
  name: string;
  href: string;
  ok: true;
  integrity: string;
  bytes: number;
};

export type AssetCheckFail = {
  name: string;
  href: string;
  ok: false;
  error: string;
  expected: string;
  actual: string | null;
  status: number | null;
};

export type AssetCheckResult = AssetCheckOk | AssetCheckFail;

export function sriSha384(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

export function docsCdnAssets(cdn: typeof DOCS_CDN = DOCS_CDN): DocsCdnAsset[] {
  return (Object.entries(cdn) as [string, { href: string; integrity: string }][]).map(
    ([name, asset]) => ({
      name,
      href: asset.href,
      integrity: asset.integrity,
    }),
  );
}

export function assertRequiredDocsCdnAssets(assets: DocsCdnAsset[]): void {
  const names = assets.map((asset) => asset.name);
  const missing = REQUIRED_DOCS_CDN_ASSETS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`DOCS_CDN missing required assets: ${missing.join(', ')}`);
  }
  if (assets.length < REQUIRED_DOCS_CDN_ASSETS.length) {
    throw new Error(
      `DOCS_CDN has ${assets.length} assets; expected at least ${REQUIRED_DOCS_CDN_ASSETS.length}`,
    );
  }
}

export function formatAssetFailure(result: AssetCheckFail): string {
  const actual = result.actual ?? '(none — fetch/status failed)';
  return [
    `DOCS_CDN.${result.name} FAILED`,
    `  url:      ${result.href}`,
    `  status:   ${result.status ?? 'n/a'}`,
    `  expected: ${result.expected}`,
    `  actual:   ${actual}`,
    `  error:    ${result.error}`,
  ].join('\n');
}

export async function checkDocsCdnAsset(
  asset: DocsCdnAsset,
  fetchImpl: typeof fetch = fetch,
): Promise<AssetCheckResult> {
  let res: Response;
  try {
    res = await fetchImpl(asset.href, {
      redirect: 'follow',
      headers: { 'User-Agent': DOCS_SRI_USER_AGENT },
    });
  } catch (err) {
    return {
      name: asset.name,
      href: asset.href,
      ok: false,
      expected: asset.integrity,
      actual: null,
      status: null,
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status !== 200) {
    return {
      name: asset.name,
      href: asset.href,
      ok: false,
      expected: asset.integrity,
      actual: null,
      status: res.status,
      error: `HTTP ${res.status} (expected 200)`,
    };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = sriSha384(bytes);
  if (actual !== asset.integrity) {
    return {
      name: asset.name,
      href: asset.href,
      ok: false,
      expected: asset.integrity,
      actual,
      status: res.status,
      error: 'SRI mismatch (sha384 of unpkg bytes != DOCS_CDN.integrity)',
    };
  }

  return {
    name: asset.name,
    href: asset.href,
    ok: true,
    integrity: actual,
    bytes: bytes.byteLength,
  };
}

export async function verifyDocsCdnSri(
  assets: DocsCdnAsset[] = docsCdnAssets(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; results: AssetCheckResult[] }> {
  assertRequiredDocsCdnAssets(assets);
  const results: AssetCheckResult[] = [];
  for (const asset of assets) {
    results.push(await checkDocsCdnAsset(asset, fetchImpl));
  }
  return { ok: results.every((row) => row.ok), results };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const printOnly = argv.includes('--print');
  const assets = docsCdnAssets();
  assertRequiredDocsCdnAssets(assets);

  console.log(`Checking ${assets.length} DOCS_CDN unpkg pins (sha384 SRI)…`);
  const { ok, results } = await verifyDocsCdnSri(assets);
  let failed = 0;

  for (const result of results) {
    if (result.ok) {
      console.log(`OK  ${result.name}  ${result.integrity}  ${result.bytes} bytes  ${result.href}`);
      continue;
    }
    failed += 1;
    const message = formatAssetFailure(result);
    console.error(`::error title=Docs CDN SRI failed (${result.name})::${result.error}`);
    console.error(message);
    if (printOnly && result.actual) {
      console.log(`PRINT ${result.name}  ${result.actual}  ${result.href}`);
    }
  }

  if (!ok) {
    console.error(
      `\n${failed}/${results.length} docs CDN SRI check(s) failed. ` +
        'Browser will block /docs or /redoc if integrity does not match unpkg bytes. ' +
        'Re-bump: GET the URL, sha384 the body as sha384-<base64>, update DOCS_CDN.',
    );
    return printOnly ? 0 : 1;
  }

  console.log(`All ${results.length} DOCS_CDN integrity pins match unpkg bytes.`);
  return 0;
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedAsCli()) {
  main().then((code) => {
    process.exit(code);
  }, (err: unknown) => {
    console.error('::error::Docs CDN SRI check crashed');
    console.error(err);
    process.exit(1);
  });
}
