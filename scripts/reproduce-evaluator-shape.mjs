// Compare actual bundled evaluators with identical synthetic completions. No inference.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [productArg,outArg]=process.argv.slice(2);if(!productArg||!outArg)throw Error('Use product-directory output-directory');
const product=resolve(productArg),out=resolve(outArg);
process.env.SERV_API_KEY='offline-fixture-only';process.env.SERV_BASE_URL='https://offline.invalid/v1';
let completion='',calls=0;
globalThis.fetch=async(url)=>{
 if(String(url)!=='https://offline.invalid/v1/chat/completions')throw Error('NETWORK_FORBIDDEN');
 calls++;return new Response(JSON.stringify({choices:[{message:{content:completion}}],model:'synthetic-only'}),{status:200});
};
const evaluator=join(product,'node_modules/pot-cli/dist/plan/graded-support-evaluator.js');
const {evaluateItem}=await import(pathToFileURL(evaluator).href);
const quote='The experiment observed eighteen correct extractions and two errors. Multilingual input has not been tested.';
const input={id:'shape-reproduction',question:'Check the bounded next test.',answer:'Preserve the two errors and test multilingual input next.',trace_steps:quote,
 gold_plan_steps:[0,1].map(index=>({index,description:index?'Plan follows the mandate':'Plan addresses original evidence',criticality:'critical',acceptance_criterion:'The plan preserves observed errors and untested language scope.'}))};
const valid=[0,1].map(i=>({step_id:'step_'+i,score:1,quote,reasoning:'The source supports the bounded follow-up.'}));
const cases=[
 ['valid',valid],
 ['absent_fields',valid.map(({step_id})=>({step_id}))],
 ['wrong_types',valid.map(row=>({...row,score:'1',reasoning:{text:'synthetic'},quote:['synthetic']}))],
 ['nested_fields',valid.map(({step_id,...assessment})=>({step_id,assessment}))],
 ['blank_text',valid.map(row=>({...row,reasoning:' ',quote:''}))],
 ['wrong_envelope',{verdict:'ALLOW',objections:valid}],
 ['valid_null_quote',valid.map(row=>({...row,quote:null}))],
 ['valid_fabricated_quote',valid.map(row=>({...row,quote:'A fabricated source sentence.'}))],
 ['valid_rejection',valid.map(row=>({...row,score:0,reasoning:'The claim contradicts the documented source.'}))],
 ['duplicate_step',[...valid,{...valid[0],score:0}]],
 ['missing_step',valid.slice(0,1)],
 ['invalid_json','[{PRIVATE_SYNTHETIC_FRAGMENT]'],
];
const results=[];
for(const [id,value] of cases){
 completion=typeof value==='string'?value:JSON.stringify(value);calls=0;
 const result=await evaluateItem(input,'serv-nano',{mode:'faithfulness',strictOutputContract:true,maxTokens:4096});
 results.push({id,input_completion:completion,stub_http_calls:calls,result});
}
const packageJson=JSON.parse(readFileSync(join(product,'node_modules/pot-cli/package.json'),'utf8'));
const result={execution:'actual_bundled_evaluator_synthetic_http',runtime_version:packageJson.version,
 synthetic_cases:true,original_live_output_reconstructed:false,network_requests:0,credentials_read:false,
 evaluator_sha256:createHash('sha256').update(readFileSync(evaluator)).digest('hex'),cases:results};
mkdirSync(out,{recursive:true});writeFileSync(join(out,'reproduction.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({runtime_version:result.runtime_version,cases:results.length,stub_calls:results.reduce((n,r)=>n+r.stub_http_calls,0),network_requests:0},null,2));
