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
    "id": "substitution-program",
    "cmd": "run_command: git$(echo evil) status",
    "expected": "BLOCK_OR_UNCERTAIN",
    "calls": 0
  },
  {
    "id": "backtick-program",
    "cmd": "run_command: git`echo evil` status",
    "expected": "BLOCK_OR_UNCERTAIN",
    "calls": 0
  },
  {
    "id": "env-substitution-program",
    "cmd": "env git$(echo evil) status",
    "expected": "BLOCK_OR_UNCERTAIN",
    "calls": 0
  },
  {
    "id": "substitution-secret-path",
    "cmd": "run_command: cat .en$(printf v)",
    "expected": "BLOCK_OR_UNCERTAIN",
    "calls": 0
  },
  {
    "id": "control-substitution-hard-block",
    "cmd": "run_command: git$(git clean -fdx) status",
    "expected": "BLOCK",
    "calls": 0
  },
  {
    "id": "control-literal-read",
    "cmd": "git status --short",
    "expected": "ALLOW",
    "calls": 1
  }
];
describe('unresolved shell word expansion review on c1981bd0',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it.each(cases)('$id',async x=>{
  const text=x.mandate??local;
  const body:any=buildSentinelVerifyBody({mandate:text,proposed_action:x.cmd,reasoning:'Do the requested task.',mandate_kind:'local_command',action_kind:'local_command'},'standard');
  body.mandate={...body.mandate,granted:x.granted,action:{...body.mandate.action,...x.action}};
  const item={id:'offline-review',verdict:'ALLOW',verdict_reasoning:'Synthetic all-pass panel for testing deterministic safety gates only.',step_evaluations:[0,1,2,3].map(i=>({step_id:'step_'+i,predicate:'faithful',score:0.9,quote:text,reasoning:'Synthetic pass.'})),provenance_violations:[],overall_score:0.9};
  vi.mocked(runCascade).mockResolvedValue({verdict:'ALLOW',reason:'agreement_allow',primary:item,secondary:item,primaryModel:'offline-mock-primary',secondaryModel:'offline-mock-secondary',secondaryInvoked:true,degradedMode:false,errors:[],totalLatencyMs:1} as any);
  const res=await verify(body);
  console.log(JSON.stringify({id:x.id,command:x.cmd,actual:res.verdict,expected:x.expected,cascadeCalls:vi.mocked(runCascade).mock.calls.length,commandClass:res.meta.promotion?.command_class,effect:res.meta.promotion?.local_command_effect,reason:res.meta.promotion?.reason}));
  if (x.expected === 'BLOCK_OR_UNCERTAIN') expect(['BLOCK', 'UNCERTAIN']).toContain(res.verdict); else expect(res.verdict).toBe(x.expected);
  expect(vi.mocked(runCascade)).toHaveBeenCalledTimes(x.calls);
 });
});
