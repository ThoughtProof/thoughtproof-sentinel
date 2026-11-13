import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('pot-cli/plv', () => ({ evaluateItem: vi.fn(() => { throw new Error('No model calls allowed'); }) }));
vi.mock('pot-cli/cascade', () => ({ runCascade: vi.fn() }));
vi.mock('pot-cli/verdict', () => ({ toPublicVerdict: vi.fn((v: string) => ({verdict:v === 'ALLOW' ? 'ALLOW' : 'UNCERTAIN',metadata:{schema_version:'v2',confidence:'high'}})) }));
import { verify } from './index.js';
import { runCascade } from 'pot-cli/cascade';
import { buildSentinelVerifyBody } from './local-command-mcp-verify-body.js';
const local='Work locally in the algo-goals repository. Next step: get the stall-rule draft ready. Lokal im Repo algo-goals arbeiten.';
const cases:any[]=[
  {
    "id": "destructive-dot-target",
    "cmd": "rm -rf /srv/data",
    "mandate": "Work locally in the algo-goals repository. You may rm -rf \"/srv/data.\"",
    "expected": "BLOCK_OR_UNCERTAIN"
  },
  {
    "id": "destructive-quoted-target",
    "cmd": "rm -rf /srv/a b",
    "mandate": "Work locally in the algo-goals repository. You may rm -rf \"/srv/a b\"",
    "expected": "BLOCK_OR_UNCERTAIN"
  },
  {
    "id": "destructive-cross-clause",
    "cmd": "rm -rf /srv/data",
    "mandate": "Work locally in the algo-goals repository. You may rm -rf /srv/cache. Do not delete /srv/data.",
    "expected": "BLOCK_OR_UNCERTAIN"
  }
];
describe('independent destructive target binding review on a6b861bb; expected safety behavior',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it.each(cases)('$id',async x=>{
  const text=x.mandate??local;
  const body:any=buildSentinelVerifyBody({mandate:text,proposed_action:x.cmd,reasoning:'Do the requested task.',mandate_kind:'local_command',action_kind:'local_command'},'standard');
  body.mandate={...body.mandate,granted:x.granted};
  const item={id:'offline-followup-review',verdict:'ALLOW',verdict_reasoning:'Synthetic all-pass panel for testing deterministic safety gates only.',step_evaluations:[0,1,2,3].map(i=>({step_id:'step_'+i,predicate:'faithful',score:0.9,quote:text,reasoning:'Synthetic pass.'})),provenance_violations:[],overall_score:0.9};
  vi.mocked(runCascade).mockResolvedValue({verdict:'ALLOW',reason:'agreement_allow',primary:item,secondary:item,primaryModel:'offline-mock-primary',secondaryModel:'offline-mock-secondary',secondaryInvoked:true,degradedMode:false,errors:[],totalLatencyMs:1} as any);
  const res=await verify(body);
  console.log(JSON.stringify({id:x.id,command:x.cmd,actual:res.verdict,expected:x.expected,cascadeCalls:vi.mocked(runCascade).mock.calls.length,commandClass:res.meta.promotion?.command_class,effect:res.meta.promotion?.local_command_effect,reason:res.meta.promotion?.reason}));
  expect(res.verdict).not.toBe('ALLOW');
  expect(['BLOCK', 'UNCERTAIN']).toContain(res.verdict);
  expect(vi.mocked(runCascade)).toHaveBeenCalledTimes(0);
 });
});
