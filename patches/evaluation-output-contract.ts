/** Validate consumed assessment fields before scores, IDs or fallback reasons are used. */
import {createHash} from 'node:crypto';

export interface EvaluationOutputIssue {
  code: 'invalid_json' | 'expected_array' | 'invalid_step' | 'unknown_step_id' | 'duplicate_step_id' | 'missing_step' | 'invalid_score' | 'missing_reason' | 'invalid_quote' | 'invalid_predicate';
  /** Only host-provided expected step IDs are exposed. Untrusted identifiers are not echoed. */
  step_id: string | null;
}
export interface EvaluationOutputContract {
  schema_version: 'plv.evaluator-output.v1';
  status: 'valid' | 'invalid';
  response_sha256: string;
  issues: EvaluationOutputIssue[];
}

/** A malformed assessment is not evidence against the task being assessed. No retries here. */
export function decodeEvaluationOutput(text: string, expectedIds: string[], _mode: string): {
  data: unknown[]; contract: EvaluationOutputContract;
} {
  const raw=typeof text==='string'?text:'',issues: EvaluationOutputIssue[]=[];
  const contract: EvaluationOutputContract={schema_version:'plv.evaluator-output.v1',status:'valid',
    response_sha256:createHash('sha256').update(raw).digest('hex'),issues};
  const issue=(code:EvaluationOutputIssue['code'],step_id:string|null=null)=>{
    // Bounded diagnostics. No raw output, arbitrary model IDs, quotes or credentials.
    if(issues.length<128)issues.push({code,step_id});
  };
  let data:unknown;
  // Accept a single complete Markdown fence, never an array extracted from another envelope.
  const trimmed=raw.trim(),fenced=trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  try{data=JSON.parse(fenced?fenced[1]:trimmed);}catch{issue('invalid_json');}
  if(!issues.length&&!Array.isArray(data))issue('expected_array');
  if(Array.isArray(data)){
    const expected=new Set(expectedIds),seen=new Set<string>();
    for(const value of data){
      if(!value||typeof value!=='object'||Array.isArray(value)){issue('invalid_step');continue;}
      const row=value as Record<string,unknown>,id=typeof row.step_id==='string'&&expected.has(row.step_id)?row.step_id:null;
      if(id===null){issue('unknown_step_id');continue;}
      if(seen.has(id))issue('duplicate_step_id',id);seen.add(id);
      if(typeof row.score!=='number'||!Number.isFinite(row.score)||row.score<0||row.score>1)issue('invalid_score',id);
      if(typeof row.reasoning!=='string'||!row.reasoning.trim())issue('missing_reason',id);
      // A null quote is allowed. The existing provenance rules still decide whether it supports the score.
      if(!Object.hasOwn(row,'quote')||(row.quote!==null&&(typeof row.quote!=='string'||!row.quote.trim())))issue('invalid_quote',id);
    }
    for(const id of expected)if(!seen.has(id))issue('missing_step',id);
  }
  if(issues.length)contract.status='invalid';
  // Predicate is a host-derived output, not an independent model input. The
  // evaluator recomputes it after provenance checks and score floors. Discard
  // any model-supplied label so it cannot override those checks or leak out.
  const assessments=contract.status==='valid'?(data as Record<string,unknown>[]).map(row=>{
    const assessment={...row};delete assessment.predicate;return assessment;
  }):[];
  return {data:assessments,contract};
}
