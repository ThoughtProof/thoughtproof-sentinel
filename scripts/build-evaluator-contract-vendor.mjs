// Offline, reproducible overlay on the exact bundled dependency. No npm/network or secrets.
import {readFileSync,writeFileSync,mkdtempSync,copyFileSync,rmSync,cpSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const root=resolve(import.meta.dirname,'..'),base=join(root,'vendor/pot-cli-0.8.10-tp.2.tgz');
const hash=(p,algorithm='sha256')=>createHash(algorithm).update(readFileSync(p)).digest('hex');
if(hash(base)!=='3325e44c36238583d95c90eeec0202a41e8c8e0555190450e362ea126b963b1e')throw Error('BASE_VENDOR_CHANGED');
const version='0.8.10-tp.2-eval-contract.2',filename='pot-cli-'+version+'.tgz',temp=mkdtempSync(join(tmpdir(),'pot-contract-build-')),pkg=join(temp,'package');
try{
 execFileSync('tar',['-xzf',base,'-C',temp]);
 execFileSync('patch',['-p1','--batch','--forward','-i',join(root,'patches/pot-cli-evaluator-contract.patch')],{cwd:pkg});
 copyFileSync(join(root,'patches/evaluation-output-contract.ts'),join(pkg,'src/plan/evaluation-output-contract.ts'));
 const cfg={...ts.convertCompilerOptionsFromJson(JSON.parse(readFileSync(join(pkg,'tsconfig.json'),'utf8')).compilerOptions,pkg).options,rootDir:undefined,outDir:undefined};
 for(const name of ['graded-support-evaluator','evaluation-output-contract']){
  const path=join(pkg,'src/plan',name+'.ts');
  const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{...cfg,declaration:false,declarationMap:false},fileName:'src/plan/'+name+'.ts',reportDiagnostics:true});
  if(compiled.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('TRANSPILE_FAILED: '+compiled.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
  writeFileSync(join(pkg,'dist/plan',name+'.js'),compiled.outputText);
  if(compiled.sourceMapText)writeFileSync(join(pkg,'dist/plan',name+'.js.map'),compiled.sourceMapText);
 }
 // Preserve existing declaration surface; add the two source-matched opt-in fields.
 const declarationPath=join(pkg,'dist/plan/graded-support-evaluator.d.ts');
 let declaration=readFileSync(declarationPath,'utf8');
 for(const needle of ['export interface ItemResult {','export interface EvalOptions {'])if(!declaration.includes(needle))throw Error('DECLARATION_BASE_DRIFT');
 declaration="import type { EvaluationOutputContract } from './evaluation-output-contract.js';\n"+declaration
  .replace('export interface ItemResult {','export interface ItemResult {\n    output_contract?: EvaluationOutputContract;')
  .replace('export interface EvalOptions {','export interface EvalOptions {\n    strictOutputContract?: boolean;');
 writeFileSync(declarationPath,declaration);
 // This declaration map belongs to the original declaration, not the overlay.
 if(existsSync(declarationPath+'.map'))rmSync(declarationPath+'.map');
 writeFileSync(declarationPath,readFileSync(declarationPath,'utf8').replace(/^\/\/# sourceMappingURL=.*\n?/gm,''));
 const d=ts.transpileDeclaration(readFileSync(join(pkg,'src/plan/evaluation-output-contract.ts'),'utf8'),{compilerOptions:{...cfg,declarationMap:false},fileName:'src/plan/evaluation-output-contract.ts'});
 if(d.diagnostics?.some(x=>x.category===ts.DiagnosticCategory.Error))throw Error('DECLARATION_EMIT_FAILED');
 writeFileSync(join(pkg,'dist/plan/evaluation-output-contract.d.ts'),d.outputText);
 const packagePath=join(pkg,'package.json'),packageJson=JSON.parse(readFileSync(packagePath,'utf8'));packageJson.version=version;
 writeFileSync(packagePath,JSON.stringify(packageJson,null,2)+'\n');
 const target=join(root,'vendor',filename);
 execFileSync('python3',['-c',
  'import pathlib,tarfile,gzip,sys\np=pathlib.Path(sys.argv[1]);o=pathlib.Path(sys.argv[2])\nwith o.open("wb") as f:\n with gzip.GzipFile(filename="",mode="wb",fileobj=f,mtime=0) as z:\n  with tarfile.open(fileobj=z,mode="w",format=tarfile.PAX_FORMAT) as t:\n   for x in sorted(p.rglob("*")):\n    i=t.gettarinfo(str(x),"package/"+str(x.relative_to(p)));i.uid=i.gid=0;i.uname=i.gname="";i.mtime=0;i.pax_headers={}\n    if x.is_file():\n     with x.open("rb") as b:t.addfile(i,b)\n    else:t.addfile(i)\n',pkg,target]);
 const manifest={base_sha256:hash(base),version,archive:filename,sha256:hash(target),typescript_version:ts.version,
  patch_sha256:hash(join(root,'patches/pot-cli-evaluator-contract.patch')),decoder_sha256:hash(join(root,'patches/evaluation-output-contract.ts')),network_requests:0};
 const manifestPath=join(root,'patches/vendor-manifest.json');
 if(existsSync(manifestPath)&&JSON.stringify(JSON.parse(readFileSync(manifestPath,'utf8')))!==JSON.stringify(manifest))throw Error('NON_REPRODUCIBLE_VENDOR_BUILD');
 writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 const newDependency='file:vendor/'+filename;
 for(const name of ['package.json','package-lock.json']){
  const path=join(root,name),json=JSON.parse(readFileSync(path,'utf8'));
  if(name==='package.json')json.dependencies['pot-cli']=newDependency;
  else{json.packages[''].dependencies['pot-cli']=newDependency;const entry=json.packages['node_modules/pot-cli'];entry.version=version;entry.resolved=newDependency;entry.integrity='sha512-'+createHash('sha512').update(readFileSync(target)).digest('base64');}
  writeFileSync(path,JSON.stringify(json,null,2)+'\n');
 }
 if(process.argv.includes('--install-local')){
  const targetDir=join(root,'node_modules/pot-cli');rmSync(targetDir,{recursive:true,force:true});cpSync(pkg,targetDir,{recursive:true});
 }
 console.log(JSON.stringify(manifest,null,2));
}finally{rmSync(temp,{recursive:true,force:true});}
