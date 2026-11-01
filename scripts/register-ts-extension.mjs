/**
 * Load the local `.js` → `.ts` resolver before the operator script.
 * Usage is `--import ./scripts/register-ts-extension.mjs`.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./ts-extension-hook.mjs', import.meta.url).href, {
  parentURL: pathToFileURL(process.cwd()).href,
});
