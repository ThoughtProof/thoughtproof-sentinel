/**
 * pot-cli version must come from the installed package, not a hardcoded string.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import handler from '../api/sentinel/health.js';
import { getPotCliVersion } from './runtime-versions.js';

describe('getPotCliVersion', () => {
  it('matches the installed pot-cli package.json version', () => {
    const require = createRequire(import.meta.url);
    const pkg = require('pot-cli/package.json') as { name: string; version: string };

    expect(pkg.name).toBe('pot-cli');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(getPotCliVersion()).toBe(pkg.version);
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
