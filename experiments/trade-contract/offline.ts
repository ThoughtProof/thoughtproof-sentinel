import { readFileSync } from 'node:fs';
import { DEVELOPMENT_ADAPTER, developmentFixture } from './development-fixture.ts';
import { evaluateTradeContract } from './evaluate.ts';

const usage = 'Usage: node --experimental-strip-types experiments/trade-contract/offline.ts [--input local.json --trust-adapter adapter-id] [--diagnostics]';
const args = process.argv.slice(2);
let inputPath: string | undefined;
let adapterId: string | undefined;
let diagnostics = false;
try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--diagnostics' && !diagnostics) diagnostics = true;
    else if (arg === '--input' && inputPath === undefined && args[index + 1] && !args[index + 1].startsWith('--')) inputPath = args[++index];
    else if (arg === '--trust-adapter' && adapterId === undefined && args[index + 1] && !args[index + 1].startsWith('--')) adapterId = args[++index];
    else throw new Error('Invalid arguments');
  }
  if (inputPath === undefined && adapterId !== undefined) throw new Error('No input');
  const raw: unknown = inputPath === undefined ? developmentFixture() : JSON.parse(readFileSync(inputPath, 'utf8'));
  const result = evaluateTradeContract(raw, {
    trustedAdapterIds: inputPath === undefined ? [DEVELOPMENT_ADAPTER] : adapterId === undefined ? [] : [adapterId],
    diagnostics,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.decision === 'ALLOW' ? 0 : result.decision === 'BLOCK' ? 2 : 3;
} catch {
  // Never print input text, filesystem errors, quotes or model output.
  process.stdout.write(`${JSON.stringify(evaluateTradeContract(undefined, { trustedAdapterIds: [], diagnostics }), null, 2)}\n`);
  process.stderr.write(`Could not read the offline contract or arguments. ${usage}\n`);
  process.exitCode = 3;
}
