/**
 * Apply the Sentinel vendored pot-cli 0.8.13 patch after npm install.
 *
 * The npm pin stays pot-cli@0.8.13. This does not publish a fork and does
 * not change coerceQuote. Re-running is a no-op once the markers are present.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgRoot = join(root, 'node_modules', 'pot-cli');
const evaluator = join(pkgRoot, 'dist', 'plan', 'graded-support-evaluator.js');
const evaluatorDts = join(pkgRoot, 'dist', 'plan', 'graded-support-evaluator.d.ts');
const contractSrc = join(root, 'vendor', 'pot-cli-0.8.13', 'nano-step-contract.js');
const contractDest = join(pkgRoot, 'dist', 'plan', 'nano-step-contract.js');
const snippetPath = join(root, 'vendor', 'pot-cli-0.8.13', 'evaluate-steps-with-llm.snippet.js');

if (!existsSync(evaluator)) {
  console.error('[apply-pot-cli-patches] pot-cli dist is not installed; skipping');
  process.exit(0);
}

const installed = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
if (installed.version !== '0.8.13') {
  console.error(`[apply-pot-cli-patches] expected pot-cli 0.8.13, found ${installed.version}`);
  process.exit(1);
}

copyFileSync(contractSrc, contractDest);

let js = readFileSync(evaluator, 'utf8');
const importAnchor = "import { detectMode5 } from './probes/mode5-truncation-detection.js';";
const importPatched =
  importAnchor +
  "\nimport { isNanoModel, NANO_STRICT_OUTPUT_SUFFIX, normalizeNanoStepArray, MalformedNanoStepError } from './nano-step-contract.js';";
if (!js.includes("from './nano-step-contract.js'")) {
  if (!js.includes(importAnchor)) {
    console.error('[apply-pot-cli-patches] import anchor missing');
    process.exit(1);
  }
  js = js.replace(importAnchor, importPatched);
}

const callAnchor =
  'const rawEvals = await evaluateStepsWithLLM(item, stepsForTier2, model, options.maxTokens ?? 4096, mode);';
const callPatched =
  'const rawEvals = await evaluateStepsWithLLM(item, stepsForTier2, model, options.maxTokens ?? 4096, mode, options.nanoStepContract === true);';
if (!js.includes('options.nanoStepContract === true')) {
  if (!js.includes(callAnchor)) {
    console.error('[apply-pot-cli-patches] evaluateStepsWithLLM call anchor missing');
    process.exit(1);
  }
  js = js.replace(callAnchor, callPatched);
}

if (!js.includes('normalizeNanoStepArray(first.data, expectedIds)')) {
  const start = js.indexOf('async function evaluateStepsWithLLM(');
  const end = js.indexOf('// ─── Tier-1 result → StepEvaluation converter');
  if (start < 0 || end < 0 || end < start) {
    console.error('[apply-pot-cli-patches] evaluateStepsWithLLM anchors missing');
    process.exit(1);
  }
  const snippet = readFileSync(snippetPath, 'utf8').trimEnd() + '\n';
  js = js.slice(0, start) + snippet + '\n' + js.slice(end);
}

if (!js.includes('coerceQuote(ev.quote)')) {
  console.error('[apply-pot-cli-patches] refused to drop coerceQuote');
  process.exit(1);
}

writeFileSync(evaluator, js);

let dts = readFileSync(evaluatorDts, 'utf8');
const dtsAnchor = `export interface EvalOptions {
    maxTokens?: number;
    tier1?: Tier1Config;
    mode?: EvalMode;
}`;
const dtsPatched = `export interface EvalOptions {
    maxTokens?: number;
    tier1?: Tier1Config;
    mode?: EvalMode;
    /** Sentinel trade_execution opt-in. See vendor/PATCHES.md. */
    nanoStepContract?: boolean;
}`;
if (!dts.includes('nanoStepContract?: boolean')) {
  if (!dts.includes(dtsAnchor)) {
    console.error('[apply-pot-cli-patches] EvalOptions anchor missing');
    process.exit(1);
  }
  dts = dts.replace(dtsAnchor, dtsPatched);
  writeFileSync(evaluatorDts, dts);
}

console.log('[apply-pot-cli-patches] pot-cli 0.8.13 nano step contract applied');
