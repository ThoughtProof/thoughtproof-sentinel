// Capture installed request construction before/after, replacing only HTTP with synthetic replies.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [productArg,outArg]=process.argv.slice(2);if(!productArg||!outArg)throw Error('Use product-directory output-directory');
const product=resolve(productArg),out=resolve(outArg),read=p=>JSON.parse(readFileSync(p,'utf8'));
process.env.SERV_API_KEY='offline-fixture-only';process.env.SERV_BASE_URL='https://inference-api.openserv.ai/v1';
let completion,captured=[];
globalThis.fetch=async(url,options)=>{
 assert.equal(String(url),'https://inference-api.openserv.ai/v1/chat/completions');captured.push(JSON.parse(options.body));
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(completion)}}],model:'synthetic-only'}),{status:200});
};
const {evaluateItem}=await import(pathToFileURL(join(product,'node_modules/pot-cli/dist/plan/graded-support-evaluator.js')));
const {planRevision}=await import(pathToFileURL(join(product,'src/engine/modes/plan_revision.ts')));
const cases=[];
for(const caseId of ['q-03','q-04'])for(const model of ['serv-nano','serv-swift']){
 const input=read(join(product,'src/engine/fixtures/sentinel-modes-01/'+caseId+'-request.json'));
 const {evalInput,evalMode}=planRevision(input);captured=[];
 const evidence=JSON.parse(input.evidence),quote=evidence.context.documents.find(d=>d.id==='Q1').text;
 completion=evalInput.gold_plan_steps.map(s=>({step_id:'step_'+s.index,score:caseId==='q-03'?1:0,quote,
  reasoning:caseId==='q-03'?'Synthetic supported judgment: original evidence supports investigating errors.':'Synthetic contradicted judgment: the premise overstates the original result.'}));
 const result=await evaluateItem(evalInput,model,{mode:evalMode,strictOutputContract:true,maxTokens:4096});assert.equal(captured.length,1);
 assert.equal(result.output_contract.status,'valid');assert.equal(result.verdict==='ALLOW',caseId==='q-03');
 cases.push({case_id:caseId,model,request:captured[0],synthetic_completion:completion,result});
}
const result={execution:'installed_evaluator_with_synthetic_http',runtime_version:read(join(product,'node_modules/pot-cli/package.json')).version,
 network_requests:0,credentials_read:false,original_live_output_reconstructed:false,model_effectiveness_tested:false,cases};
mkdirSync(out,{recursive:true});writeFileSync(join(out,'request-reproduction.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({runtime_version:result.runtime_version,cases:cases.length,network_requests:0}));
