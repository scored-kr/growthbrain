import { z } from 'zod';

export const identifier = z.string().uuid();
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
export const memorySchema = proposalSchema.safeExtend({
  id: identifier,
  status: z.enum(['candidate', 'active', 'rejected', 'superseded']),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  ownerId: identifier,
  projects: z.array(z.object({ id: identifier, name: z.string().trim().min(1).max(200) }).strict()).max(1000),
  memories: z.array(memorySchema).max(10000),
}).strict();
export const contextSchema = z.object({
  projectId: identifier,
  requestConditions: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), z.string().min(1).max(4000)).default({}),
  maxCharacters: z.number().int().min(512).max(32000).default(12000),
}).strict();
export type State = z.infer<typeof stateSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Scope = z.infer<typeof scopeSchema>;
