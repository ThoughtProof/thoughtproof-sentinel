/**
 * Offline replay of recorded extractor answers. Reads JSON files written by
 * `--save-raw` (`caseId`, `arm`, `content`, `usage`) and sends each body
 * through the frozen parser, the frozen gate, and the grounding follow-up.
 * It does not call a provider and does not change a verdict rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADAPTER_ID, decideCascade } from './adapter.ts';
import { caseById } from './comparison-cases.ts';
import { prepareModelContent } from './comparison-grounding.ts';
import { labelsFor, type ExpectedVerdict } from './comparison-labels.ts';
import { assessModelText } from './comparison-report.ts';
import { CHECK_IDS, type CheckId } from './contract.ts';

export interface ReplayStep {
  checkId: CheckId;
  /** Status the frozen gate assigned to that check. */
  status: 'not_verifiable';
  /** Model's own status on the same check, before the gate rewrote it. */
  modelStatus: string;
  rule: string;
  code: string;
  triggerPath: string;
  triggerValue: unknown;
}

export interface ReplayRow extends ReplayStep {
  caseId: string;
  arm: 'A' | 'B';
  expected: ExpectedVerdict;
  parserResult: string;
  frozenGateVerdict: string | null;
  publicVerdict: string | null;
  /** Later not_verifiable checks on the same answer. Not the first error. */
  followOns: ReplayStep[];
}

interface RawFile {
  caseId: string;
  arm: string;
  content: string;
}

interface SemanticCheck {
  checkId: string;
  status: string;
  requirementIds?: string[];
  quotes?: { documentId: string; quote: string }[];
}

function readRaw(dir: string): RawFile[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as RawFile);
}

function explain(
  checkId: CheckId,
  model: { semanticChecks: SemanticCheck[]; applicability: { checkId: string; status: string; basis: string }[] },
  diagnostics: { code: string; path: string }[],
): ReplayStep {
  const index = model.semanticChecks.findIndex(check => check.checkId === checkId);
  const check = index >= 0 ? model.semanticChecks[index] : undefined;
  const diagnostic = index >= 0 ? diagnostics.find(item => item.path === `$.semanticChecks[${index}]`) : undefined;
  if (diagnostic?.code === 'REQUIREMENT_SET_MISMATCH') {
    return {
      checkId, status: 'not_verifiable', modelStatus: check?.status ?? 'unknown',
      rule: 'evaluate.ts:267-269', code: diagnostic.code,
      triggerPath: `$.semanticChecks[${index}].requirementIds`,
      triggerValue: check?.requirementIds ?? [],
    };
  }
  if (diagnostic?.code === 'INVALID_SEMANTIC_EVIDENCE') {
    return {
      checkId, status: 'not_verifiable', modelStatus: check?.status ?? 'unknown',
      rule: 'evaluate.ts:278-285', code: diagnostic.code,
      triggerPath: `$.semanticChecks[${index}].quotes`,
      triggerValue: check?.quotes ?? [],
    };
  }
  const appIndex = model.applicability.findIndex(row => row.checkId === checkId);
  const app = diagnostics.find(item => item.path === `$.applicability[${appIndex}]`);
  if (app?.code === 'APPLICABILITY_CONFLICT') {
    return {
      checkId, status: 'not_verifiable', modelStatus: model.applicability[appIndex]?.status ?? 'unknown',
      rule: 'evaluate.ts:256-257', code: app.code,
      triggerPath: `$.applicability[${appIndex}]`,
      triggerValue: model.applicability[appIndex],
    };
  }
  if (check && !diagnostic && (check.status === 'not_applicable' || check.status === 'not_verifiable')) {
    return {
      checkId, status: 'not_verifiable', modelStatus: check.status,
      rule: 'evaluate.ts:277', code: 'model_status',
      triggerPath: `$.semanticChecks[${index}].status`,
      triggerValue: check.status,
    };
  }
  const fallback = diagnostics.find(item => item.path.includes(checkId)) ?? diagnostics[0];
  return {
    checkId, status: 'not_verifiable', modelStatus: check?.status ?? 'unknown',
    rule: 'evaluate.ts:100-103', code: fallback?.code ?? 'none',
    triggerPath: fallback?.path ?? `$.checks[${CHECK_IDS.indexOf(checkId)}]`,
    triggerValue: fallback ?? null,
  };
}

function uncertainSteps(publicContent: string, documents: ReturnType<typeof caseById>['documents']): {
  first: ReplayStep;
  followOns: ReplayStep[];
} {
  const model = JSON.parse(publicContent) as {
    semanticChecks: SemanticCheck[];
    applicability: { checkId: string; status: string; basis: string }[];
  };
  const gated = decideCascade(documents, { ok: true, content: publicContent }, null, {
    trustedAdapterIds: [ADAPTER_ID],
    diagnostics: true,
  });
  const failed = gated.checks.filter(check => check.status === 'not_verifiable');
  const first = failed[0];
  if (!first) throw new Error('replay expected a not_verifiable check');
  const diagnostics = gated.diagnostics ?? [];
  return {
    first: explain(first.checkId, model, diagnostics),
    followOns: failed.slice(1).map(check => explain(check.checkId, model, diagnostics)),
  };
}

/** Replay every recorded answer in `dir` through the frozen path. */
export function replayDirectory(dir: string): ReplayRow[] {
  const expected = new Map(labelsFor('dev').map(label => [label.caseId, label.expected]));
  return readRaw(dir)
    .map(file => {
      const item = caseById(file.caseId);
      const assessed = assessModelText(item.documents, file.content);
      const prepared = prepareModelContent(file.content, item.documents, 'primary');
      const steps = assessed.parserResult === 'ok'
        ? uncertainSteps(prepared.publicContent, item.documents)
        : {
          first: {
            checkId: 'decision_basis' as const,
            status: 'not_verifiable' as const,
            modelStatus: 'unparsed',
            rule: 'adapter.ts parseOutput',
            code: assessed.parserResult,
            triggerPath: '$',
            triggerValue: null,
          },
          followOns: [],
        };
      return {
        caseId: file.caseId,
        arm: file.arm === 'B' ? 'B' as const : 'A' as const,
        expected: expected.get(file.caseId) ?? 'UNCERTAIN',
        parserResult: assessed.parserResult,
        frozenGateVerdict: assessed.frozenGateVerdict,
        publicVerdict: assessed.publicVerdict,
        ...steps.first,
        followOns: steps.followOns,
      };
    })
    .sort((left, right) => left.caseId.localeCompare(right.caseId) || left.arm.localeCompare(right.arm));
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: comparison-replay.ts <raw-dir>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(replayDirectory(dir), null, 2)}\n`);
}
