/**
 * Runtime versions for public health / OpenAPI.
 * pot-cli is read from the installed (vendored) package.json — never hardcoded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function versionFromPackageJson(pkgJsonPath: string): string | undefined {
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (parsed.name !== 'pot-cli') return undefined;
    if (typeof parsed.version !== 'string' || parsed.version.trim().length === 0) {
      return undefined;
    }
    return parsed.version.trim();
  } catch {
    return undefined;
  }
}

function walkForPotCliPackageJson(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', 'pot-cli', 'package.json');
    const version = versionFromPackageJson(candidate);
    if (version) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Installed pot-cli semver, or `unavailable` if the package.json cannot be read. */
export function getPotCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('pot-cli/package.json');
    const version = versionFromPackageJson(resolved);
    if (version) return version;
  } catch {
    // fall through to filesystem walk
  }

  const fromModule = walkForPotCliPackageJson(dirname(fileURLToPath(import.meta.url)));
  if (fromModule) return fromModule;

  const fromCwd = walkForPotCliPackageJson(process.cwd());
  if (fromCwd) return fromCwd;

  return 'unavailable';
}
