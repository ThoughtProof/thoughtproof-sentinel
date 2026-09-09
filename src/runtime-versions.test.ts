/**
 * pot-cli version must come from the installed package, not a hardcoded string.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import handler from '../api/sentinel/health.js';
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
    });
    expect((body as { pot_cli: string }).pot_cli).toMatch(/^\d+\.\d+\.\d+/);
  });
});
