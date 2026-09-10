/**
 * pot-cli version must come from the installed package, not a hardcoded string.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import handler from '../api/sentinel/health.js';
import { getModelReadiness } from './model-config.js';
import { getPotCliVersion } from './runtime-versions.js';

function installedPotCliVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), 'node_modules', 'pot-cli', 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  expect(pkg.name).toBe('pot-cli');
  return pkg.version;
}

describe('getPotCliVersion', () => {
  it('matches the installed pot-cli package.json version', () => {
    const pkgVersion = installedPotCliVersion();

    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(getPotCliVersion()).toBe(pkgVersion);
    expect(getPotCliVersion()).not.toBe('0.1.0');
    expect(getPotCliVersion()).not.toBe('unavailable');
  });
});

describe('health handler import graph', () => {
  it('does not import auth or JSON rate-limit policy (Preview load crash)', () => {
    const src = readFileSync(join(process.cwd(), 'api/sentinel/health.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"].*auth\.js['"]/);
    expect(src).not.toMatch(/from ['"].*rate-limit-policy/);
    expect(src).toMatch(/from ['"].*upstash-env\.js['"]/);
    expect(src).not.toMatch(/from ['"].*upstash-config/);
  });
});

describe('RateLimitBackend single source (#50 hygiene)', () => {
  it('is declared only in upstash-env.ts', () => {
    const decl = /export type RateLimitBackend\s*=/;
    const env = readFileSync(join(process.cwd(), 'src/upstash-env.ts'), 'utf8');
    const policy = readFileSync(join(process.cwd(), 'src/rate-limit-policy.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/types.ts'), 'utf8');
    expect(env).toMatch(decl);
    expect(policy).not.toMatch(decl);
    expect(types).not.toMatch(decl);
    expect(types).toMatch(/Liveness only — process answered/);
    expect(types).toMatch(/ok: boolean;/);
    const afterOk = types.split('export interface SentinelHealthResponse')[1] ?? '';
    const okBlock = afterOk.slice(0, afterOk.indexOf('ready?'));
    expect(okBlock).toMatch(/Liveness only — process answered/);
  });
});

describe('GET /sentinel/health', () => {
  it('includes pot_cli from the installed package', () => {
    const potCli = getPotCliVersion();
    const headers: Record<string, string> = {};
    let statusCode = 0;
    let body: unknown;

    const res = {
      setHeader(key: string, value: string) {
        headers[key] = value;
      },
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: unknown) {
        body = data;
        return this;
      },
      end() {
        return this;
      },
    };

    handler({ method: 'GET' } as never, res as never);

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      version: '0.1.0',
      pot_cli: potCli,
      serv_key: getModelReadiness().serv_key,
    });
    expect((body as { pot_cli: string }).pot_cli).toMatch(/^\d+\.\d+\.\d+/);
    expect(['present', 'missing']).toContain((body as { serv_key: string }).serv_key);
    expect(['redis', 'in_memory', 'unavailable']).toContain(
      (body as { rate_limit: string }).rate_limit,
    );
    expect(typeof (body as { ready: boolean }).ready).toBe('boolean');
    expect((body as { ok: boolean }).ok).toBe(true);
  });
});
