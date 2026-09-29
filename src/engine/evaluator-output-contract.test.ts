import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
// The actual installed model router, parser, provenance floors, cascade and Sentinel are exercised.
// Only HTTP completions are synthetic; no credential is read and fetch cannot reach the network.
vi.hoisted(()=>{process.env.SERV_API_KEY='offline-fixture-only';process.env.SERV_BASE_URL='https://offline.invalid/v1';});
import {evaluateItem} from 'pot-cli/plv';
import {verify} from './index.js';
import {getModeHandler} from './modes/index.js';
import type {SentinelVerifyRequest} from '../types.js';
import openapi from '../../api/openapi.js';

const evidence='The experiment observed eighteen correct extractions and two errors. Multilingual input has not been tested.';
const request:SentinelVerifyRequest={id:'contract-fixture',claim:'Preserve the two errors and test multilingual input next.',evidence,mode:'plan_revision',tier:'standard'};
const shaped=()=>getModeHandler(request.mode)({...request,id:'fixture'});
const valid=(ids=['step_0','step_1'],score=1)=>ids.map(step_id=>({step_id,score,quote:score===1?evidence:null,
 reasoning:score===1?'The source supports the bounded note and follow-up.':'The supplied source contradicts this proposed assertion.',
 predicate:score===1?'faithful':'unfaithful',tier:score===1?'verbatim':'none',abstain_if_uncertain:false}));
const omit=(rows:any[],key:string)=>rows.map(row=>{const clone={...row};delete clone[key];return clone;});
const mutations: Array<[string,(rows:any[])=>unknown,string]>=[
 ['missing reason',r=>omit(r,'reasoning'),'missing_reason'],
 ['empty reason',r=>r.map(x=>({...x,reasoning:' '})),'missing_reason'],
 ['non-string reason',r=>r.map(x=>({...x,reasoning:{text:'not a string'}})),'missing_reason'],
 ['missing quote field',r=>omit(r,'quote'),'invalid_quote'],
 ['object quote',r=>r.map(x=>({...x,quote:{value:evidence}})),'invalid_quote'],
 ['blank quote',r=>r.map(x=>({...x,quote:' '})),'invalid_quote'],
 ['duplicate ID',r=>[...r,{...r[0],score:0,predicate:'unfaithful'}],'duplicate_step_id'],
 ['unknown ID',r=>[...r,{...r[0],step_id:'untrusted-secret-looking-value'}],'unknown_step_id'],
 ['missing expected step',r=>r.slice(0,1),'missing_step'],
 ['missing score',r=>omit(r,'score'),'invalid_score'],
 ['string score',r=>r.map(x=>({...x,score:'1'})),'invalid_score'],
 ['score outside range',r=>r.map(x=>({...x,score:1.1})),'invalid_score'],
 ['negative score',r=>r.map(x=>({...x,score:-.1})),'invalid_score'],
 ['null score',r=>r.map(x=>({...x,score:null})),'invalid_score'],
 ['wrong envelope',r=>({verdict:'ALLOW',objections:r}),'expected_array'],
 ['empty array',()=>[],'missing_step'],
 ['null row',()=>[null],'invalid_step'],
];
let completions:string[],calls:number;
beforeEach(()=>{
 calls=0;completions=[];vi.stubEnv('CONFIRM_BLOCKS','0');
 vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
  expect(String(url)).toBe('https://offline.invalid/v1/chat/completions');
  const body=JSON.parse(String(options?.body));expect(body.model).toMatch(/^serv-(nano|swift)$/);
  calls++;if(!completions.length)throw Error('UNPLANNED_SYNTHETIC_HTTP');
  return new Response(JSON.stringify({choices:[{message:{content:completions.shift()}}],model:'synthetic-only'}),{status:200});
 }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('strict evaluator response contract through real provider parser',()=>{
 for(const [name,mutate,code] of mutations)it(name+' is a technical HOLD without fabricated failed steps or a retry',async()=>{
  completions=[JSON.stringify(mutate(valid()))];const {evalInput,evalMode}=shaped();
  const result=await evaluateItem(evalInput,'serv-nano',{mode:evalMode,strictOutputContract:true});
  expect(calls).toBe(1);expect(result.verdict).toBe('HOLD');expect(result.step_evaluations).toEqual([]);
  expect(result.output_contract?.status).toBe('invalid');expect(result.output_contract?.issues.some(i=>i.code===code)).toBe(true);
  expect(JSON.stringify(result.output_contract)).not.toContain('untrusted-secret-looking-value');
  expect(result.output_contract?.response_sha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('accepts complete output and a single Markdown code fence',async()=>{
  const {evalInput,evalMode}=shaped();for(const text of [JSON.stringify(valid()),'```json\n'+JSON.stringify(valid())+'\n```']){
   completions.push(text);const r=await evaluateItem(evalInput,'serv-nano',{mode:evalMode,strictOutputContract:true});expect(r.verdict).toBe('ALLOW');expect(r.output_contract?.status).toBe('valid');
  }expect(calls).toBe(2);
 });
 it('keeps existing quote provenance restrictions even when the output schema is valid',async()=>{
  const {evalInput,evalMode}=shaped();for(const quote of [null,'A fabricated quote absent from the source.']){
   completions.push(JSON.stringify(valid().map(s=>({...s,quote}))));const r=await evaluateItem(evalInput,'serv-nano',{mode:evalMode,strictOutputContract:true});
   expect(r.output_contract?.status).toBe('valid');expect(r.verdict).toBe('HOLD');expect(r.step_evaluations.every(s=>s.score<=.25)).toBe(true);
  }
 });
 it('reports malformed JSON without the legacy three automatic inference attempts',async()=>{
  completions=['[{not JSON}]'];const {evalInput,evalMode}=shaped();const r=await evaluateItem(evalInput,'serv-nano',{mode:evalMode,strictOutputContract:true});
  expect(calls).toBe(1);expect(r.output_contract?.issues).toEqual([{code:'invalid_json',step_id:null}]);
 });
 it('leaves the legacy opt-out API unchanged',async()=>{
  completions=[JSON.stringify(omit(valid(),'reasoning'))];const {evalInput,evalMode}=shaped();const r=await evaluateItem(evalInput,'serv-nano',{mode:evalMode});
  expect(r.verdict).toBe('ALLOW');expect(r.output_contract).toBeUndefined();
 });
});
describe('native Sentinel handling of invalid assessments',()=>{
 it('retains review after malformed primary and valid secondary ALLOW, exposing the actual missing fields',async()=>{
  completions=[JSON.stringify(omit(omit(valid(),'reasoning'),'quote')),JSON.stringify(valid())];
  const response=await verify(request),trace=response.meta.verifier_trace!;
  expect(response.verdict).toBe('UNCERTAIN');expect(response.confidence).toBe(0);expect(response.reasoning).toContain('missing assessment fields are not missing task evidence');
  expect(trace.stages[0].output_contract?.status).toBe('invalid');expect(trace.stages[0].objections).toEqual([]);
  expect(trace.stages[1].verdict).toBe('ALLOW');expect(trace.stages[1].output_contract?.status).toBe('valid');expect(calls).toBe(2);
 });
 it('does not turn an invalid secondary response into an ALLOW',async()=>{
  completions=[JSON.stringify(valid()),JSON.stringify(omit(valid(),'reasoning'))];const r=await verify(request);
  expect(r.verdict).toBe('UNCERTAIN');expect(r.meta.verifier_trace?.stages[1].output_contract?.status).toBe('invalid');expect(calls).toBe(2);
 });
 it('can retain a genuine secondary BLOCK after invalid primary',async()=>{
  completions=[JSON.stringify(omit(valid(),'reasoning')),JSON.stringify(valid(undefined,0))];const r=await verify(request);
  expect(r.verdict).toBe('BLOCK');expect(r.objections.every(o=>o.reasoning.includes('contradicts'))).toBe(true);
 });
 it('distinguishes both invalid stages from a semantic rejection',async()=>{
  completions=['[]','[]'];const r=await verify(request);expect(r.verdict).toBe('UNCERTAIN');expect(r.objections).toEqual([]);
  expect(r.meta.verifier_trace?.stages.every(s=>s.output_contract?.status==='invalid')).toBe(true);expect(calls).toBe(2);
 });
 it('fails closed for an invalid checkpoint-only assessment',async()=>{
  completions=['[]'];const r=await verify({...request,tier:'checkpoint'});expect(r.verdict).toBe('UNCERTAIN');expect(calls).toBe(1);
 });
 it('retains a valid primary BLOCK and the existing early exit',async()=>{
  completions=[JSON.stringify(valid(undefined,0))];const r=await verify(request);expect(r.verdict).toBe('BLOCK');expect(calls).toBe(1);
  expect(r.meta.verifier_trace?.stages[1].status).toBe('not_invoked');
 });
 it('does not permit trade-reasoning promotion to bypass an invalid primary',async()=>{
  const rows=valid(['step_0','step_1','step_2']);rows[2]={...rows[2],score:.5,predicate:'partially_faithful',tier:'partial'};
  completions=['[]',JSON.stringify(rows)];const r=await verify({...request,mode:'trade_reasoning'});expect(r.verdict).toBe('UNCERTAIN');expect(r.meta.promotion?.promoted).not.toBe(true);
 });
 it('does not permit action-authorization promotion to bypass an invalid primary',async()=>{
  completions=['[]',JSON.stringify(valid(['step_0','step_1','step_2','step_3']))];
  const r=await verify({...request,mode:'action_authorization',claim:'Notify Alex that the internal report is ready.',evidence:'Principal mandate: Notify Alex that the internal report is ready. Proposed action: Notify Alex that the internal report is ready. Agent reasoning: This is the requested informational update.'});
  expect(r.verdict).not.toBe('ALLOW');expect(r.meta.promotion?.promoted).not.toBe(true);
 });
 it('documents the unsigned diagnostic schema',()=>{
  let doc:any;const res={setHeader(){},status(){return res;},json(value:unknown){doc=value;}};
  openapi({} as never,res as never);
  const schema=doc.paths['/sentinel/verify'].post.responses['200'].content['application/json'].schema.properties.meta.properties.verifier_trace;
  expect(schema.properties.signature_scope.enum).toContain('unsigned_diagnostics');
  expect(schema.properties.stages.items.properties.output_contract.properties.status.enum).toEqual(['valid','invalid']);
 });
});
