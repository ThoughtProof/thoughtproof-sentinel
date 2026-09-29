import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
// Exercise the actual bundled evaluator and native cascade; only HTTP is synthetic.
vi.hoisted(()=>{process.env.SERV_API_KEY='offline-fixture-only';process.env.SERV_BASE_URL='https://offline.invalid/v1';});
import {evaluateItem} from 'pot-cli/plv';
import {verify} from './index.js';
import {getModeHandler} from './modes/index.js';
import type {SentinelVerifyRequest} from '../types.js';
import openapi from '../../api/openapi.js';

const evidence='The experiment observed eighteen correct extractions and two errors. Multilingual input has not been tested.';
const request:SentinelVerifyRequest={id:'shape-fixture',claim:'Preserve the errors and test multilingual input next.',evidence,mode:'plan_revision',tier:'standard'};
const rows=()=>['step_0','step_1'].map(step_id=>({step_id,score:1,quote:evidence,reasoning:'The original source supports the bounded next test.'}));
let completions:string[],calls:number;
beforeEach(()=>{
 completions=[];calls=0;vi.stubEnv('CONFIRM_BLOCKS','0');
 vi.stubGlobal('fetch',vi.fn(async(url)=>{
  expect(String(url)).toBe('https://offline.invalid/v1/chat/completions');
  if(!completions.length)throw Error('UNPLANNED_SYNTHETIC_HTTP');calls++;
  return new Response(JSON.stringify({choices:[{message:{content:completions.shift()}}],model:'synthetic-only'}),{status:200});
 }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
async function assess(value:unknown,stepCount=2){
 const {evalInput,evalMode}=getModeHandler(request.mode)({...request,id:'shape-fixture'});
 evalInput.gold_plan_steps=evalInput.gold_plan_steps.slice(0,stepCount);
 completions.push(typeof value==='string'?value:JSON.stringify(value));
 return evaluateItem(evalInput,'serv-nano',{mode:evalMode,strictOutputContract:true});
}
const shape=(r:any)=>r.output_contract?.shape;
describe('bounded assessment shape diagnostics',()=>{
 it('distinguishes absent core fields for both recognized steps',async()=>{
  const r=await assess(rows().map(({step_id})=>({step_id}))),s=shape(r);
  expect(s).toMatchObject({schema_version:'plv.evaluator-shape.v1',json:'parsed',root_type:'array',expected_steps:2,root_items:2,recognized_steps:2,truncated:false});
  expect(s.rows).toHaveLength(2);
  for(const row of s.rows)for(const key of ['score','reasoning','quote'])expect(row.fields[key]).toEqual({type:'absent',state:'missing'});
  expect(r.verdict).toBe('HOLD');expect(r.step_evaluations).toEqual([]);expect(calls).toBe(1);
 });
 it('distinguishes wrong types without coercing or exposing their values',async()=>{
  const r=await assess(rows().map(row=>({...row,score:'1',reasoning:{secret:'PRIVATE_REASON'},quote:['PRIVATE_QUOTE']}))),s=shape(r);
  expect(s.rows[0].fields).toEqual({score:{type:'string',state:'wrong_type'},reasoning:{type:'object',state:'wrong_type'},quote:{type:'array',state:'wrong_type'}});
  expect(JSON.stringify(s)).not.toMatch(/PRIVATE_REASON|PRIVATE_QUOTE/);expect(r.verdict).toBe('HOLD');expect(calls).toBe(1);
 });
 it('distinguishes blank text from a missing field',async()=>{
  const r=await assess(rows().map(row=>({...row,reasoning:' \n ',quote:''}))),s=shape(r);
  expect(s.rows[0].fields.reasoning).toEqual({type:'string',state:'empty'});
  expect(s.rows[0].fields.quote).toEqual({type:'string',state:'empty'});expect(r.verdict).toBe('HOLD');
 });
 it.each([-1,1.1])('reports an out-of-range score %s without publishing its value',async score=>{
  const r=await assess(rows().map(row=>({...row,score,quote:null}))),s=shape(r);
  expect(s.rows[0].fields.score).toEqual({type:'number',state:'out_of_range'});
  expect(s.rows[0].fields.quote).toEqual({type:'null',state:'valid'});expect(r.verdict).toBe('HOLD');
 });
 it('distinguishes JSON numeric overflow from nonnumeric scores',async()=>{
  const r=await assess('[{"step_id":"step_0","score":1e999,"reasoning":"ok","quote":null},{"step_id":"step_1","score":1e999,"reasoning":"ok","quote":null}]');
  expect(shape(r).rows[0].fields.score).toEqual({type:'number',state:'non_finite'});expect(r.verdict).toBe('HOLD');
 });
 it.each(['assessment','evaluation','result'])('reports fields nested under %s without accepting them as flat assessments',async container=>{
  const r=await assess(rows().map(({step_id,...fields})=>({step_id,[container]:fields}))),s=shape(r);
  expect(s.rows[0].fields.score.state).toBe('missing');
  expect(s.rows[0].nested).toEqual([{container,type:'object',fields:{score:{type:'number',state:'valid'},reasoning:{type:'string',state:'valid'},quote:{type:'string',state:'valid'}}}]);
  expect(r.output_contract?.status).toBe('invalid');expect(r.verdict).toBe('HOLD');expect(r.step_evaluations).toEqual([]);expect(calls).toBe(1);
 });
 it('reports a verdict/objections envelope without extracting it or retrying',async()=>{
  const r=await assess({verdict:'ALLOW',objections:rows()}),s=shape(r);
  expect(s.root_type).toBe('object');expect(s.rows).toHaveLength(0);expect(s.containers[0]).toMatchObject({container:'objections',type:'array',items:2});
  expect(s.containers[0].rows[0].fields.score.state).toBe('valid');expect(r.output_contract?.issues).toEqual([{code:'expected_array',step_id:null}]);expect(calls).toBe(1);
 });
 it('diagnoses a single object but still requires the explicitly requested array',async()=>{
  const r=await assess(rows()[0],1),s=shape(r);expect(s.root_type).toBe('object');expect(s.rows[0].fields.score.state).toBe('valid');
  expect(r.output_contract?.status).toBe('invalid');expect(r.verdict).toBe('HOLD');
 });
 it.each([1,2])('preserves valid %s-step arrays and their grounded decisions',async count=>{
  const r=await assess(rows().slice(0,count),count),s=shape(r);expect(r.output_contract?.status).toBe('valid');expect(r.verdict).toBe('ALLOW');
  expect(s.expected_steps).toBe(count);expect(s.recognized_steps).toBe(count);expect(s.rows).toHaveLength(count);
  expect(r.step_evaluations.every(row=>row.quote===evidence&&row.score===1)).toBe(true);expect(calls).toBe(1);
 });
 it('reports invalid JSON without guessing a root shape or copying raw text',async()=>{
  const r=await assess('[PRIVATE_FRAGMENT'),s=shape(r);expect(s).toMatchObject({json:'invalid',root_type:'unparsed',root_items:null,recognized_steps:0,rows:[],containers:[]});
  expect(JSON.stringify(s)).not.toContain('PRIVATE_FRAGMENT');expect(r.output_contract?.issues).toEqual([{code:'invalid_json',step_id:null}]);expect(calls).toBe(1);
 });
 it('does not expose unknown keys, model IDs or nested text in diagnostics',async()=>{
  const r=await assess([{step_id:'PRIVATE_MODEL_ID',score:'PRIVATE_SCORE',reasoning:'PRIVATE_REASON',quote:'PRIVATE_QUOTE',PRIVATE_KEY:'PRIVATE_VALUE',assessment:{score:1,reasoning:'PRIVATE_NESTED',quote:'PRIVATE_QUOTE'}}]);
  const s=shape(r);expect(s.rows[0]).toMatchObject({step_id:null,id_status:'unknown'});expect(JSON.stringify(s)).not.toContain('PRIVATE_');expect(r.verdict).toBe('HOLD');
 });
 it('truncates diagnostics, while still validating errors after the eighth row',async()=>{
  const {evalInput,evalMode}=getModeHandler(request.mode)({...request,id:'shape-fixture'});
  evalInput.gold_plan_steps=Array.from({length:20},(_,index)=>({...evalInput.gold_plan_steps[0],index}));
  const value=Array.from({length:20},(_,i)=>({...rows()[0],step_id:'step_'+i}));delete (value[19] as any).reasoning;
  completions.push(JSON.stringify(value));const r=await evaluateItem(evalInput,'serv-nano',{mode:evalMode,strictOutputContract:true}),s=shape(r);
  expect(s.root_items).toBe(20);expect(s.recognized_steps).toBe(20);expect(s.rows).toHaveLength(8);expect(s.truncated).toBe(true);
  expect(r.output_contract?.issues).toContainEqual({code:'missing_reason',step_id:'step_19'});expect(r.verdict).toBe('HOLD');
 });
 it('bounds all known envelope samples together and never recurses through arbitrary objects',async()=>{
  const values=Array.from({length:100},()=>({...rows()[0],assessment:{score:1,reasoning:'PRIVATE',quote:'PRIVATE',evaluation:{reasoning:'PRIVATE_DEEP'}}}));
  const r=await assess({evaluations:values,assessments:values,results:values,steps:values,objections:values,result:values,evaluation:values,assessment:values}),s=shape(r);
  expect(s.containers.reduce((n:number,c:any)=>n+c.rows.length,0)).toBeLessThanOrEqual(8);expect(s.truncated).toBe(true);
  expect(JSON.stringify(s).length).toBeLessThan(12000);expect(JSON.stringify(s)).not.toContain('PRIVATE');expect(r.verdict).toBe('HOLD');
 });
 it.each([null,'An invented sentence not present in the source.'])('preserves provenance rejection for a structurally valid quote (%s)',async quote=>{
  const r=await assess(rows().map(row=>({...row,quote})));expect(shape(r).rows[0].fields.quote.state).toBe('valid');
  expect(r.output_contract?.status).toBe('valid');expect(r.verdict).toBe('HOLD');expect(r.step_evaluations.every(row=>row.score<=.25)).toBe(true);
 });
 it('exposes primary shape defects despite a valid secondary ALLOW',async()=>{
  completions=[JSON.stringify(rows().map(({step_id,...assessment})=>({step_id,assessment}))),JSON.stringify(rows())];
  const response=await verify(request),stages=response.meta.verifier_trace!.stages;
  expect(response.verdict).toBe('UNCERTAIN');expect(response.confidence).toBe(0);expect(stages[0].objections).toEqual([]);
  expect(shape(stages[0]).rows[0].nested[0].fields.score.state).toBe('valid');expect(shape(stages[1]).rows[0].fields.score.state).toBe('valid');expect(calls).toBe(2);
 });
 it('documents the optional unsigned diagnostic with fixed field/type enums',()=>{
  let doc:any;const res={setHeader(){},status(){return res;},json(value:unknown){doc=value;}};openapi({} as never,res as never);
  const trace=doc.paths['/sentinel/verify'].post.responses['200'].content['application/json'].schema.properties.meta.properties.verifier_trace;
  const s=trace.properties.stages.items.properties.output_contract.properties.shape;
  expect(s.properties.schema_version.enum).toEqual(['plv.evaluator-shape.v1']);expect(s.properties.rows.maxItems).toBe(8);
  expect(s.properties.rows.items.properties.fields.properties.score.properties.type.enum).toContain('absent');expect(s.additionalProperties).toBe(false);
 });
});
