/**
 * Resolve local `.js` imports to sibling `.ts` files so
 * `node --experimental-strip-types` can run the operator script.
 * This hook does not read environment values and does not print them.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  const local = specifier.startsWith('./') || specifier.startsWith('../');
  if (local && specifier.endsWith('.js') && context.parentURL) {
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
    const candidate = fileURLToPath(new URL(tsSpecifier, context.parentURL));
    if (existsSync(candidate)) return nextResolve(tsSpecifier, context);
  }
  return nextResolve(specifier, context);
}
