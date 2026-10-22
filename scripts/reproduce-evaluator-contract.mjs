// Real installed parser/evaluator, synthetic HTTP completion only. No network or secrets.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const out=process.argv[2];if(!out)throw Error('Output directory required');
process.env.SERV_API_KEY='offline-fixture-only';
process.env.SERV_BASE_URL='https://offline.invalid/v1';
let completion='',calls=0;
globalThis.fetch=async(url,options)=>{
 if(String(url)!=='https://offline.invalid/v1/chat/completions')throw Error('NETWORK_FORBIDDEN');
 calls++;return new Response(JSON.stringify({choices:[{message:{content:completion}}],model:'offline-fixture'}),{status:200,headers:{'Content-Type':'application/json'}});
};
const {evaluateItem}=await import('pot-cli/plv');
const quote='The experiment observed eighteen correct extractions and two errors. Multilingual input has not been tested.';
const input={id:'offline-reproduction',question:'Check the proposed faithful note and bounded follow-up.',answer:'Report eighteen correct extractions and two errors. Test multilingual input next.',trace_steps:quote,
 gold_plan_steps:[0,1].map(index=>({index,description:index?'The next test preserves uncertainty':'The note preserves observed errors',criticality:'critical',acceptance_criterion:'The proposed bounded note and follow-up are supported by the supplied source.'}))};
const valid=[0,1].map(i=>({step_id:'step_'+i,score:1,tier:'verbatim',quote,quote_location:{line_start:null,line_end:null,char_offset_start:null,char_offset_end:null,turn:null},quote_to_criterion_mapping:'The source supports the bounded statement.',reasoning:'The source reports the errors and states the untested scope.',abstain_if_uncertain:false,predicate:'faithful'}));
const without=(rows,...keys)=>rows.map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>!keys.includes(k))));
const cases=[
 ['valid_complete',valid],
 ['missing_reason',without(valid,'reasoning')],
 ['missing_quote_and_reason',without(valid,'reasoning','quote')],
 ['zero_scores_without_reasons',without(valid.map(r=>({...r,score:0,predicate:'unfaithful',tier:'none',quote:null})),'reasoning')],
 ['duplicate_conflicting_id',[...valid,{...valid[0],score:0,predicate:'unfaithful',tier:'none',reasoning:'A conflicting assessment for the same step.'}]],
 ['unknown_extra_id',[...valid,{...valid[0],step_id:'step_999'}]],
 ['missing_expected_step',valid.slice(0,1)],
 ['missing_scores',without(valid,'score')],
 ['string_scores',valid.map(r=>({...r,score:'1'}))],
 ['out_of_range_scores',valid.map(r=>({...r,score:3}))],
 ['embedded_wrong_envelope',{verdict:'ALLOW',objections:valid}],
 ['empty_array',[]],
 ['malformed_json','RAW:[{bad json}]'],
];
const rows=[];
for(const [id,value] of cases){
 completion=typeof value==='string'&&value.startsWith('RAW:')?value.slice(4):JSON.stringify(value);calls=0;
 let result=null,error=null;try{result=await evaluateItem(input,'serv-nano',{mode:'faithfulness',maxTokens:4096,strictOutputContract:process.argv.includes('--strict')});}catch(e){error=String(e);}
 rows.push({id,input_completion:completion,stub_http_calls:calls,result,error});
}
mkdirSync(out,{recursive:true});const path=resolve('node_modules/pot-cli/dist/plan/graded-support-evaluator.js');
const report={execution:'offline_actual_evaluator_with_synthetic_http',strict:process.argv.includes('--strict'),network_requests:0,credentials_read:false,source:path,source_sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),rows};
writeFileSync(join(out,'reproduction.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(rows.map(r=>({id:r.id,verdict:r.result?.verdict,steps:r.result?.step_evaluations.map(s=>({id:s.step_id,score:s.score,reason:s.reasoning})),error:r.error,stub_calls:r.stub_http_calls})),null,2));
