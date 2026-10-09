/**
 * Resolve relative `.js` specifiers to sibling `.ts` sources.
 * Used only by the localhost pre-publish server so Node can load the
 * API handlers without a Vercel deploy. Real `.js` files (node_modules,
 * pot-cli dist) stay as `.js` when no `.ts` sibling exists.
 */

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && specifier.endsWith('.js')) {
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
    try {
      return await nextResolve(tsSpecifier, context);
    } catch (err) {
      if (err && err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
  }
  return nextResolve(specifier, context);
}
