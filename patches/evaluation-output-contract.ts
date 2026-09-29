/** Validate consumed assessment fields before scores, IDs or fallback reasons are used. */
import {createHash} from 'node:crypto';

export type AssessmentValueType = 'absent' | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
export interface AssessmentFieldShape {
  type: AssessmentValueType;
  state: 'missing' | 'wrong_type' | 'empty' | 'out_of_range' | 'non_finite' | 'valid';
}
export type AssessmentFields = Record<'score' | 'reasoning' | 'quote', AssessmentFieldShape>;
export interface AssessmentRowShape {
  position: number;
  type: AssessmentValueType;
  /** Only an expected, host-generated ID may appear; unknown model IDs stay null. */
  step_id: string | null;
  id_status: 'known' | 'unknown' | 'missing' | 'wrong_type' | 'not_object';
  fields: AssessmentFields | null;
  nested: Array<{container: 'assessment' | 'evaluation' | 'result'; type: AssessmentValueType; fields: AssessmentFields | null}>;
}
export interface EvaluationOutputShape {
  schema_version: 'plv.evaluator-shape.v1';
  json: 'parsed' | 'invalid';
  root_type: AssessmentValueType | 'unparsed';
  expected_steps: number;
  root_items: number | null;
  /** Unique expected IDs in the actual top-level array, not in an alternate envelope. */
  recognized_steps: number;
  /** At most eight row samples across rows and all containers combined. */
  rows: AssessmentRowShape[];
  containers: Array<{
    container: 'evaluations' | 'assessments' | 'results' | 'steps' | 'objections' | 'result' | 'evaluation' | 'assessment';
    type: AssessmentValueType;
    items: number | null;
    rows: AssessmentRowShape[];
  }>;
  truncated: boolean;
}

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
  /** Additive unsigned shape metadata; never used to authorize, coerce or repair an assessment. */
  shape?: EvaluationOutputShape;
}

function valueType(value: unknown): AssessmentValueType {
  if(value===undefined)return 'absent';
  if(value===null)return 'null';
  if(Array.isArray(value))return 'array';
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}
function object(value: unknown): Record<string,unknown> | null {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function fieldShape(row: Record<string,unknown>, key: 'score'|'reasoning'|'quote'): AssessmentFieldShape {
  if(!Object.hasOwn(row,key))return {type:'absent',state:'missing'};
  const value=row[key],type=valueType(value);
  if(key==='score')return {type,state:type!=='number'?'wrong_type':!Number.isFinite(value)?'non_finite':
    (value as number)<0||(value as number)>1?'out_of_range':'valid'};
  if(key==='quote'&&value===null)return {type,state:'valid'};
  return {type,state:typeof value!=='string'?'wrong_type':value.trim()?'valid':'empty'};
}
function fields(row: Record<string,unknown>): AssessmentFields {
  return {score:fieldShape(row,'score'),reasoning:fieldShape(row,'reasoning'),quote:fieldShape(row,'quote')};
}

/** Fixed names, types and counts only. Never copy values, extra keys or recursively inspect model objects. */
function describeShape(data: unknown, parsed: boolean, expectedIds: string[]): EvaluationOutputShape {
  const expected=new Set(expectedIds);
  const shape: EvaluationOutputShape={schema_version:'plv.evaluator-shape.v1',json:parsed?'parsed':'invalid',
    root_type:parsed?valueType(data):'unparsed',expected_steps:expectedIds.length,
    root_items:Array.isArray(data)?data.length:null,recognized_steps:0,rows:[],containers:[],truncated:false};
  if(!parsed)return shape;
  let remaining=8;
  function describeRows(values: unknown[]): AssessmentRowShape[] {
    if(values.length>remaining)shape.truncated=true;
    return values.slice(0,remaining).map((value,position)=>{
      remaining--;
      const row=object(value),id=row?.step_id;
      const known=typeof id==='string'&&expected.has(id);
      return {position,type:valueType(value),step_id:known?id:null,
        id_status:!row?'not_object':!Object.hasOwn(row,'step_id')?'missing':typeof id!=='string'?'wrong_type':known?'known':'unknown',
        fields:row?fields(row):null,
        nested:row?(['assessment','evaluation','result'] as const).filter(key=>Object.hasOwn(row,key)).map(container=>{
          const child=object(row[container]);
          return {container,type:valueType(row[container]),fields:child?fields(child):null};
        }):[]};
    });
  }
  if(Array.isArray(data)){
    const ids=new Set(data.map(value=>object(value)?.step_id).filter((id):id is string=>typeof id==='string'&&expected.has(id)));
    shape.recognized_steps=ids.size;shape.rows=describeRows(data);
  }else{
    const root=object(data);
    if(root){
      if(['step_id','score','reasoning','quote'].some(key=>Object.hasOwn(root,key)))shape.rows=describeRows([root]);
      for(const container of ['evaluations','assessments','results','steps','objections','result','evaluation','assessment'] as const){
        if(!Object.hasOwn(root,container))continue;
        const value=root[container];
        shape.containers.push({container,type:valueType(value),items:Array.isArray(value)?value.length:null,
          rows:Array.isArray(value)?describeRows(value):object(value)?describeRows([value]):[]});
      }
    }
  }
  return shape;
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
  let parsed=false;
  try{data=JSON.parse(fenced?fenced[1]:trimmed);parsed=true;}catch{issue('invalid_json');}
  contract.shape=describeShape(data,parsed,expectedIds);
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
