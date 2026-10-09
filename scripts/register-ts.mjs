/**
 * Load the `.js` → `.ts` resolver before the localhost server entry.
 * Start with: node --experimental-strip-types --import ./scripts/register-ts.mjs
 */
import { register } from 'node:module';

register('./ts-extension-resolve.mjs', import.meta.url);
