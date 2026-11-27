import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RawUsage {
  cost_in_usd_ticks: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface RawCapture {
  caseId: string;
  arm: 'A' | 'B';
  content: string | null;
  usage: RawUsage | null;
}

/** Only these fields are written. Headers and API keys are not accepted. */
export function rawCaptureBody(input: RawCapture): string {
  const usage = input.usage === null ? null : {
    cost_in_usd_ticks: input.usage.cost_in_usd_ticks,
    prompt_tokens: input.usage.prompt_tokens,
    completion_tokens: input.usage.completion_tokens,
  };
  return `${JSON.stringify({
    caseId: input.caseId,
    arm: input.arm,
    content: input.content,
    usage,
  })}\n`;
}

export function saveRawResponse(dir: string, input: RawCapture): string {
  if (input.caseId.includes('/') || input.caseId.includes('..') || input.arm.includes('/')) {
    throw new Error('RAW_PATH');
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${input.caseId}-${input.arm}.json`);
  writeFileSync(file, rawCaptureBody(input), { encoding: 'utf8' });
  return file;
}
