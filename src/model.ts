import { z } from 'zod';
import { isAbsolute, normalize, parse } from 'node:path';

export const identifier = z.string().uuid();
export const siteSchema=z.enum(['chatgpt.com','claude.ai']);
export const captureInputSchema=z.object({
  site:siteSchema, projectId:identifier, url:z.string().url().max(2048),
  messageId:z.string().min(1).max(160), role:z.enum(['user','assistant']), text:z.string().trim().min(1).max(12000),
}).strict();
const historicalCaptureSchema=captureInputSchema.extend({
  id:identifier, contentHash:z.string().regex(/^[0-9a-f]{64}$/), capturedAt:z.string().datetime(), previousId:identifier.optional(),
}).strict();
const importId=z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
export const chatImportSourceSchema=z.object({provider:z.enum(['chatgpt-export','claude-export']),branchMode:z.enum(['current','unverified-flat']),conversationId:importId,title:z.string().min(1).max(500),branchLeafId:importId.nullable(),messageId:importId,createdAt:z.string().datetime().nullable()}).strict();
export const captureSchema=historicalCaptureSchema.extend({text:z.string().min(1).max(12000).refine(t=>!!t.trim()),importSource:chatImportSourceSchema.optional()}).strict();
export const chatImportInputSchema=z.object({
  projectId:identifier,confirmed:z.literal(true),allowUnverifiedBranch:z.boolean(),provider:z.enum(['chatgpt-export','claude-export']),branchMode:z.enum(['current','unverified-flat']),conversationId:importId,title:z.string().min(1).max(500),branchLeafId:importId.nullable(),
  messages:z.array(z.object({id:importId,role:z.enum(['user','assistant']),text:z.string().min(1).max(12000).refine(t=>!!t.trim()),createdAt:z.string().datetime().nullable()}).strict()).min(1).max(20),
}).strict().refine(v=>new Set(v.messages.map(m=>m.id)).size===v.messages.length,'Duplicate message IDs').refine(v=>v.branchMode==='current'?v.branchLeafId!==null&&!v.allowUnverifiedBranch:v.provider==='claude-export'&&v.branchLeafId===null&&v.allowUnverifiedBranch,'Explicit branch review required');
export const consentSchema=z.object({site:siteSchema,projectId:identifier,enabled:z.boolean()}).strict();
export const agentClientSchema=z.enum(['codex','claude-code']);
export const workspaceSchema=z.string().min(1).max(4096).refine(p=>isAbsolute(p)&&normalize(p)===p&&p!==parse(p).root,'Select an absolute project directory');
const eventId=z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
export const agentBindingInputSchema=z.object({client:agentClientSchema,workspace:workspaceSchema,projectId:identifier,enabled:z.boolean()}).strict();
export const agentBindingSchema=agentBindingInputSchema.extend({id:identifier,consentedAt:z.string().datetime()}).strict();
export const agentCaptureInputSchema=z.object({client:agentClientSchema,workspace:workspaceSchema,bindingId:identifier,sessionId:eventId,turnId:eventId,role:z.enum(['user','assistant']),text:z.string().trim().min(1).max(12000)}).strict();
export const agentCaptureSchema=agentCaptureInputSchema.extend({id:identifier,projectId:identifier,contentHash:z.string().regex(/^[0-9a-f]{64}$/),capturedAt:z.string().datetime(),previousId:identifier.optional()}).strict();
export const projectTriggerSchema=z.object({projectId:identifier,keywords:z.array(z.string().trim().min(2).max(80)).min(1).max(20)}).strict();
export const scopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('project'), projectId: identifier }).strict(),
]);
export const sourceSchema = z.object({
  kind: z.enum(['user', 'ai', 'capture']),
  reference: z.string().min(1).max(2048),
  excerpt: z.string().min(1).max(4000),
}).strict();
const handoffText=z.string().trim().min(1).max(800);
export const handoffProposalSchema=z.object({
  projectId:identifier,goal:handoffText,
  completed:z.array(z.object({claim:handoffText,evidence:handoffText}).strict()).max(10),
  blockers:z.array(handoffText).max(10),nextActions:z.array(handoffText).min(1).max(10),
  observedAt:z.string().datetime(),expiresAt:z.string().datetime(),source:sourceSchema,
  supersedesId:identifier.optional(),
}).strict().refine(h=>Date.parse(h.expiresAt)>Date.parse(h.observedAt)&&Date.parse(h.expiresAt)-Date.parse(h.observedAt)<=30*24*60*60*1000,'Handoff validity must be positive and at most 30 days');
export const handoffSchema=handoffProposalSchema.safeExtend({id:identifier,status:z.enum(['candidate','active','rejected','superseded','retired']),createdAt:z.string().datetime(),reviewedAt:z.string().datetime().optional()});
const baseProposalSchema = z.object({
  scope: scopeSchema,
  kind: z.enum(['preference', 'decision', 'constraint', 'goal', 'feedback']),
  key: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  value: z.string().trim().min(1).max(4000),
  source: sourceSchema,
  reason: z.string().trim().min(1).max(2000),
  supersedesId: identifier.optional(),
}).strict().superRefine((p, ctx) => {
  if (p.scope.type === 'global' && p.kind !== 'preference') {
    ctx.addIssue({ code: 'custom', message: 'Global scope is reserved for explicitly selected preferences' });
  }
});
export const taskTypeSchema=z.enum(['writing','translation','campaign','analysis','coding']);
export const applicabilitySchema=z.object({taskTypes:z.array(taskTypeSchema).min(1).max(5).refine(types=>new Set(types).size===types.length,'Task types must be unique')}).strict();
export const proposalSchema=baseProposalSchema.safeExtend({applicability:applicabilitySchema.optional()});
const legacyMemorySchema = baseProposalSchema.safeExtend({
  id: identifier,
  status: z.enum(['candidate', 'active', 'rejected', 'superseded']),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
});
const historicalMemorySchema = baseProposalSchema.safeExtend({
  ...legacyMemorySchema.shape,
  status: z.enum(['candidate', 'active', 'rejected', 'superseded', 'retired']),
  correctionOf: identifier.optional(),
  retiredAt: z.string().datetime().optional(),
  retirementReason: z.string().trim().min(1).max(2000).optional(),
});
const taskMemorySchema=historicalMemorySchema.safeExtend({applicability:applicabilitySchema.optional()});
export const memorySchema=taskMemorySchema.safeExtend({pinned:z.boolean().optional()});
const legacyStateSchema = z.object({
  version: z.literal(1),
  ownerId: identifier,
  projects: z.array(z.object({ id: identifier, name: z.string().trim().min(1).max(200) }).strict()).max(1000),
  memories: z.array(legacyMemorySchema).max(10000),
}).strict();
const captureStateSchema=legacyStateSchema.extend({
  version:z.literal(2), captures:z.array(historicalCaptureSchema).max(5000), captureSettings:z.array(consentSchema).max(2),
}).strict();
const reviewStateSchema=captureStateSchema.extend({version:z.literal(3),memories:z.array(historicalMemorySchema).max(10000)}).strict();
const agentStateSchema=reviewStateSchema.extend({version:z.literal(4),agentBindings:z.array(agentBindingSchema).max(1000),agentCaptures:z.array(agentCaptureSchema).max(5000),projectTriggers:z.array(projectTriggerSchema).max(1000)}).strict();
const taskStateSchema=agentStateSchema.extend({version:z.literal(5),memories:z.array(taskMemorySchema).max(10000)}).strict();
const importStateSchema=taskStateSchema.extend({version:z.literal(6),captures:z.array(captureSchema).max(5000)}).strict();
const handoffStateSchema=importStateSchema.extend({version:z.literal(7),memories:z.array(memorySchema).max(10000),handoffs:z.array(handoffSchema).max(1000)}).strict();
const usageCounter=z.object({units:z.number().int().nonnegative(),minute:z.number().int().nonnegative(),calls:z.number().int().nonnegative()}).strict();
const inferenceStateSchema=handoffStateSchema.extend({version:z.literal(8),inferenceUsage:z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),...usageCounter.shape,projects:z.record(identifier,usageCounter)}).strict()}).strict();
// Cross-alias supersession requires the v9 interpretation contract.
export const STATE_VERSION=9;
export const stateSchema=inferenceStateSchema.extend({version:z.literal(STATE_VERSION)}).strict();
export function parseState(state: unknown) {
  const inferenceUsage={day:'1970-01-01',units:0,minute:0,calls:0,projects:{}};
  const additions={agentBindings:[],agentCaptures:[],projectTriggers:[]};
  if(typeof state==='object' && state!==null && 'version' in state && state.version===1) {
    return stateSchema.parse({...legacyStateSchema.parse(state),version:STATE_VERSION,inferenceUsage,handoffs:[],captures:[],captureSettings:[],...additions});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===2) {
    return stateSchema.parse({...captureStateSchema.parse(state),version:STATE_VERSION,inferenceUsage,handoffs:[],...additions});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===3) {
    return stateSchema.parse({...reviewStateSchema.parse(state),version:STATE_VERSION,inferenceUsage,handoffs:[],...additions});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===4) {
    return stateSchema.parse({...agentStateSchema.parse(state),version:STATE_VERSION,inferenceUsage,handoffs:[]});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===5) {
    return stateSchema.parse({...taskStateSchema.parse(state),version:STATE_VERSION,inferenceUsage,handoffs:[]});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===6) {
    return stateSchema.parse({...importStateSchema.parse(state),version:STATE_VERSION,inferenceUsage,handoffs:[]});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===7) {
    return stateSchema.parse({...handoffStateSchema.parse(state),version:STATE_VERSION,inferenceUsage});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===8) {
    return stateSchema.parse({...inferenceStateSchema.parse(state),version:STATE_VERSION});
  }
  return stateSchema.parse(state);
}
export const requestConditionsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), z.string().trim().min(1).max(4000)).default({});
export const contextSchema = z.object({
  projectId: identifier.optional(),
  taskType: taskTypeSchema.optional(),
  query:z.string().max(2000).default(''),
  requestConditions: requestConditionsSchema,
  maxCharacters: z.number().int().min(512).max(32000).default(12000),
}).strict();
export const searchSchema = z.object({
  projectId: identifier.optional(),
  taskType: taskTypeSchema.optional(),
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(20),
  requestConditions: requestConditionsSchema,
}).strict();
export type State = z.infer<typeof stateSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type TaskType=z.infer<typeof taskTypeSchema>;
export type CaptureInput=z.infer<typeof captureInputSchema>;
export type Capture=z.infer<typeof captureSchema>;
