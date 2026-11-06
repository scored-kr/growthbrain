import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,proposal,approve} from './helpers.mjs';
import {MemoryEngine} from '../dist/engine.js';
import {contextOutputSchema} from '../dist/mcp-contract.js';
const tasks=(...taskTypes)=>({applicability:{taskTypes}});
const handoff=projectId=>({projectId,goal:'Launch approved landing copy',completed:[{claim:'Draft reviewed',evidence:'User review notes, synthetic document revision 2'}],blockers:['Waiting on pricing'],nextActions:['Draft FAQ with latest approved tone'],observedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),source:{kind:'ai',reference:'synthetic:session:2',excerpt:'Draft is claimed complete; inspect evidence'}});

test('general default and disjoint task exceptions coexist; search and context choose exactly the same applicable variant',()=>{
 const {engine,project,other}=fixture();
 const general=approve(engine,proposal({type:'global'},'tone','concise default'));
 const analytical=approve(engine,proposal({type:'global'},'tone','detailed analysis',tasks('analysis')));
 const writing=approve(engine,proposal({type:'global'},'tone','warm writing',tasks('writing')));
 const projectDefault=approve(engine,proposal({type:'project',projectId:project.id},'tone','project default'));
 const projectCampaign=approve(engine,proposal({type:'project',projectId:project.id},'tone','campaign exception',tasks('campaign')));
 for(const [projectId,taskType,expected] of [[undefined,undefined,general],[undefined,'analysis',analytical],[undefined,'writing',writing],[other.id,'analysis',analytical],[project.id,'analysis',projectDefault],[project.id,'campaign',projectCampaign]]) {
  assert.equal(engine.getContext({projectId,taskType}).conditions[0].memoryId,expected);
  assert.deepEqual(engine.search(projectId,'tone',20,{},taskType).matches.map(m=>m.id),[expected]);
 }
 assert.deepEqual(engine.search(project.id,'tone',20,{tone:'explicit request'},'campaign').matches,[]);
 const restored=new MemoryEngine(engine.snapshot());assert.equal(restored.getContext({taskType:'analysis'}).conditions[0].memoryId,analytical);
 restored.retireMemory(project.id,analytical,'Remove exception');assert.equal(restored.getContext({taskType:'analysis'}).conditions[0].memoryId,general);
});

test('overlapping exceptions require explicit replacement; multi-conflict approval fails atomically',()=>{
 const {engine}=fixture(),scope={type:'global'};
 const writing=approve(engine,proposal(scope,'tone','writing',tasks('writing')));
 const analysis=approve(engine,proposal(scope,'tone','analysis',tasks('analysis')));
 const overlap=engine.propose(proposal(scope,'tone','both',tasks('analysis','writing')));
 const before=engine.snapshot();assert.throws(()=>engine.review(overlap.id,'approve',analysis),/MULTIPLE_SUPERSESSIONS_REQUIRED/);assert.deepEqual(engine.snapshot(),before);
 engine.retireMemory(engine.snapshot().projects[0].id,writing,'Consolidate exception');
 assert.throws(()=>engine.review(overlap.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
 engine.review(overlap.id,'approve',analysis);
 assert.equal(new MemoryEngine(engine.snapshot()).getContext({taskType:'writing'}).conditions[0].memoryId,overlap.id);
 const corrupt=engine.snapshot();corrupt.memories.find(m=>m.id===writing).status='active';delete corrupt.memories[0].retiredAt;delete corrupt.memories[0].retirementReason;
 assert.throws(()=>new MemoryEngine(corrupt),/AMBIGUOUS_ACTIVE_MEMORY/);
});

test('handoff stays unapproved and project isolated, requires local review and never claims independent verification',()=>{
 const {engine,project,other}=fixture();const candidate=engine.proposeHandoff(handoff(project.id));
 assert.deepEqual(engine.getContext({projectId:project.id}).handoff,{status:'none'});
 assert.throws(()=>engine.reviewHandoff(other.id,candidate.id,'approve'),/CANDIDATE_NOT_FOUND/);
 engine.reviewHandoff(project.id,candidate.id,'approve');
 const context=engine.getContext({projectId:project.id});contextOutputSchema.parse(context);
 assert.equal(context.handoff.status,'current');assert.equal(context.handoff.verification,'user_reviewed_claims_not_independently_verified');assert.equal(context.handoff.record.id,candidate.id);
 for(const selection of [{},{projectId:other.id}])assert.ok(!JSON.stringify(engine.getContext(selection)).includes(candidate.id));
 assert.deepEqual(engine.getContext({projectId:project.id},true).handoff,{status:'none'});
 assert.deepEqual(engine.search(project.id,'Launch approved landing copy').matches,[]);
 assert.throws(()=>engine.proposeHandoff({...handoff(project.id),status:'active'}));
 assert.throws(()=>engine.proposeHandoff({...handoff(project.id),completed:[{claim:'Tests passed',evidence:''}]}));
 assert.throws(()=>engine.proposeHandoff({...handoff(project.id),observedAt:new Date(Date.now()+600000).toISOString()}),/INVALID_HANDOFF_TIME/);
});

test('handoff replacement, expiry, retirement and small budgets never resurrect or partially relay old completion claims',()=>{
 const {engine,project}=fixture();const first=engine.proposeHandoff(handoff(project.id));engine.reviewHandoff(project.id,first.id,'approve');
 const next=engine.proposeHandoff({...handoff(project.id),goal:'Next stage'});
 assert.throws(()=>engine.reviewHandoff(project.id,next.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
 engine.reviewHandoff(project.id,next.id,'approve',first.id);
 assert.equal(engine.getContext({projectId:project.id}).handoff.record.id,next.id);
 assert.deepEqual(engine.getContext({projectId:project.id,maxCharacters:512}).handoff,{status:'omitted'});
 const state=engine.snapshot(),now=Date.now();const active=state.handoffs.at(-1);active.observedAt=new Date(now-86400000).toISOString();active.expiresAt=new Date(now-1).toISOString();
 const expired=new MemoryEngine(state);assert.deepEqual(expired.getContext({projectId:project.id}).handoff,{status:'stale'});
 engine.retireHandoff(project.id,next.id);assert.deepEqual(new MemoryEngine(engine.snapshot()).getContext({projectId:project.id}).handoff,{status:'none'});
 assert.throws(()=>engine.reviewHandoff(project.id,first.id,'approve'),/CANDIDATE_NOT_FOUND/);
});

test('state v6 migration has no handoffs, rejects undeclared fields; invalid restored handoff graph fails closed',()=>{
 const {engine,project,other}=fixture();const {handoffs,inferenceUsage,...v6}=engine.snapshot();v6.version=6;
 assert.deepEqual(new MemoryEngine(v6).snapshot().handoffs,[]);
 assert.throws(()=>new MemoryEngine({...v6,handoffs:[]}));
 const first=engine.proposeHandoff(handoff(project.id));engine.reviewHandoff(project.id,first.id,'approve');
 const second=engine.proposeHandoff({...handoff(project.id),supersedesId:first.id});engine.reviewHandoff(project.id,second.id,'approve');
 const state=engine.snapshot();state.handoffs[0].projectId=other.id;assert.throws(()=>new MemoryEngine(state),/INVALID_SUPERSESSION/);
 const missingReview=engine.snapshot();delete missingReview.handoffs[1].reviewedAt;assert.throws(()=>new MemoryEngine(missingReview),/REVIEW_EVIDENCE_REQUIRED/);
});

test('pins order eligible memory within precedence; they cannot override current requests, projects, tasks or retirement',()=>{
 const {engine,project,other}=fixture(),scope={type:'project',projectId:project.id};
 approve(engine,proposal(scope,'a_first','normal'));const pinned=approve(engine,proposal(scope,'z_last','important'));
 const global=approve(engine,proposal({type:'global'},'a_first','common overridden'));
 engine.pinMemory(project.id,pinned,true);engine.pinMemory(project.id,global,true);
 assert.equal(engine.getContext({projectId:project.id}).conditions[0].memoryId,pinned);
 assert.equal(engine.getContext({projectId:project.id,requestConditions:{a_first:'now'}}).conditions[0].origin,'current_request');
 assert.ok(!JSON.stringify(engine.getContext({projectId:project.id})).includes(global));
 assert.equal(engine.listMemories(project.id,'active').memories[0].pinned,true);
 assert.throws(()=>engine.pinMemory(other.id,pinned,true),/ACTIVE_MEMORY_NOT_FOUND/);
 const candidate=engine.propose(proposal(scope,'pending','candidate'));assert.throws(()=>engine.pinMemory(project.id,candidate.id,true),/ACTIVE_MEMORY_NOT_FOUND/);
 const exception=approve(engine,proposal(scope,'only','analysis only',tasks('analysis')));engine.pinMemory(project.id,exception,true);
 assert.ok(!JSON.stringify(engine.getContext({projectId:project.id,taskType:'writing'})).includes(exception));
 engine.retireMemory(project.id,pinned,'No longer applicable');assert.ok(!JSON.stringify(engine.getContext({projectId:project.id})).includes(pinned));
 const restored=new MemoryEngine(engine.snapshot());assert.equal(restored.dashboard(project.id).metrics.pinned,2);assert.equal(restored.dashboard(other.id).metrics.candidates,0);
 assert.equal(restored.dashboard(project.id).personalizationVerified,false);
});
