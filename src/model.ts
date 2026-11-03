import { z } from 'zod';

export const identifier = z.string().uuid();
export const siteSchema=z.enum(['chatgpt.com','claude.ai']);
export const captureInputSchema=z.object({
  site:siteSchema, projectId:identifier, url:z.string().url().max(2048),
  messageId:z.string().min(1).max(160), role:z.enum(['user','assistant']), text:z.string().trim().min(1).max(12000),
}).strict();
export const captureSchema=captureInputSchema.extend({
  id:identifier, contentHash:z.string().regex(/^[0-9a-f]{64}$/), capturedAt:z.string().datetime(), previousId:identifier.optional(),
}).strict();
export const consentSchema=z.object({site:siteSchema,projectId:identifier,enabled:z.boolean()}).strict();
export const scopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('project'), projectId: identifier }).strict(),
]);
export const sourceSchema = z.object({
  kind: z.enum(['user', 'ai', 'capture']),
  reference: z.string().min(1).max(2048),
  excerpt: z.string().min(1).max(4000),
}).strict();
export const proposalSchema = z.object({
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
const legacyMemorySchema = proposalSchema.safeExtend({
  id: identifier,
  status: z.enum(['candidate', 'active', 'rejected', 'superseded']),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
});
export const memorySchema = proposalSchema.safeExtend({
  ...legacyMemorySchema.shape,
  status: z.enum(['candidate', 'active', 'rejected', 'superseded', 'retired']),
  correctionOf: identifier.optional(),
  retiredAt: z.string().datetime().optional(),
  retirementReason: z.string().trim().min(1).max(2000).optional(),
});
const legacyStateSchema = z.object({
  version: z.literal(1),
  ownerId: identifier,
  projects: z.array(z.object({ id: identifier, name: z.string().trim().min(1).max(200) }).strict()).max(1000),
  memories: z.array(legacyMemorySchema).max(10000),
}).strict();
const captureStateSchema=legacyStateSchema.extend({
  version:z.literal(2), captures:z.array(captureSchema).max(5000), captureSettings:z.array(consentSchema).max(2),
}).strict();
export const stateSchema=captureStateSchema.extend({version:z.literal(3),memories:z.array(memorySchema).max(10000)}).strict();
export function parseState(state: unknown) {
  if(typeof state==='object' && state!==null && 'version' in state && state.version===1) {
    return stateSchema.parse({...legacyStateSchema.parse(state),version:3,captures:[],captureSettings:[]});
  }
  if(typeof state==='object' && state!==null && 'version' in state && state.version===2) {
    return stateSchema.parse({...captureStateSchema.parse(state),version:3});
  }
  return stateSchema.parse(state);
}
export const contextSchema = z.object({
  projectId: identifier,
  requestConditions: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), z.string().min(1).max(4000)).default({}),
  maxCharacters: z.number().int().min(512).max(32000).default(12000),
}).strict();
export type State = z.infer<typeof stateSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type CaptureInput=z.infer<typeof captureInputSchema>;
export type Capture=z.infer<typeof captureSchema>;
