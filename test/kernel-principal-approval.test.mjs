import test from 'node:test';
import assert from 'node:assert/strict';
import {principalApprovalPlan,normalizeApprovalPolicy,normalizeApprovalAuthorities} from '../src/kernel/approval-policy.mjs';
import {phaseAccessIdentity,phaseTransitionAccess} from '../src/kernel/phase-preparation.mjs';
const author={principalId:'author',actorKind:'human',identity:{name:'Author',email:'author@example.test',login:null}};
const reviewer={principalId:'reviewer',actorKind:'human',identity:{name:'Reviewer',email:'reviewer@example.test',login:null}};
function fixture(){const authorities=normalizeApprovalAuthorities({reviewers:{members:[{email:author.identity.email},{email:reviewer.identity.email}]}});
  const policy=normalizeApprovalPolicy({authorities:['reviewers'],minimum:1,allowSelfApproval:false},authorities,'team-review');
  const phase={id:'team-review',approvalPolicy:policy,generatedBy:author.identity};
  return {phase,workflow:{workItem:{id:'EXAMPLE'},resolution:{approvalAuthorities:authorities}},active:[]};}
test('pure principal approval uses pinned membership and distinct human identity without changing inputs',()=>{
  const {phase,workflow}=fixture(),before=structuredClone({phase,workflow,author,reviewer});
  assert.deepEqual(principalApprovalPlan(workflow,phase,{actor:reviewer,agentId:null},{author}),
    {key:'reviewer@example.test',authorityGroup:'reviewers',selfApproval:false,reached:true});
  assert.deepEqual({phase,workflow,author,reviewer},before);
  assert.throws(()=>principalApprovalPlan(workflow,phase,{actor:author,agentId:null},{author}),{code:'APPROVAL_SELF_APPROVAL_PROHIBITED'});
  assert.throws(()=>principalApprovalPlan(workflow,phase,{actor:{...reviewer,principalId:author.principalId},agentId:null},{author}),{code:'APPROVAL_SELF_APPROVAL_PROHIBITED'});
  assert.throws(()=>principalApprovalPlan(workflow,phase,{actor:{...reviewer,actorKind:'service'},agentId:null},{author}),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  assert.throws(()=>principalApprovalPlan(workflow,phase,{actor:reviewer,agentId:null},{author,active:[{decision:'approved',actor:reviewer.identity,
    principalId:'another-login',authorityGroup:'reviewers'}]}),{code:'APPROVAL_IDENTITY_ALREADY_RECORDED'});
});
test('receipt identity observation grants no fresh phase permission and preserves existing access refusals',()=>{
  const facts={projectId:'project',...reviewer,agentId:null,permissions:[]};
  assert.deepEqual(phaseAccessIdentity(facts,'project'),{actor:reviewer,agentId:null});
  assert.throws(()=>phaseTransitionAccess(facts,'project','phase.approve'),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.throws(()=>phaseAccessIdentity(facts,'other'),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.throws(()=>phaseTransitionAccess({...facts,permissions:['phase.approve']},'project','phase.approve',
    {expected:{actor:author,agentId:null}}),{code:'ENGINE_ACTOR_CHANGED'});
});
