import { z } from 'zod';
import { identifier, proposalSchema, scopeSchema, sourceSchema } from './model.js';

const routingSchema = z.object({
  projectId: identifier.nullable(),
  reason: z.enum(['explicit_project', 'configured_trigger', 'project_selection_required', 'common_only']),
  candidateProjectIds: z.array(identifier).max(1000),
}).strict();
const condition = { key: proposalSchema.shape.key, value: proposalSchema.shape.value };
const stored = { ...condition, memoryId: identifier, source: sourceSchema, reason: proposalSchema.shape.reason, supersedesId: identifier.optional() };
export const contextOutputSchema = z.object({
  projectId: identifier.nullable(), routing: routingSchema,
  searchedScopes: z.array(z.string()).min(1).max(2),
  conditions: z.array(z.discriminatedUnion('origin', [
    z.object({ ...condition, origin: z.literal('current_request') }).strict(),
    z.object({ ...stored, origin: z.literal('project') }).strict(),
    z.object({ ...stored, origin: z.literal('global') }).strict(),
  ])),
  omittedCount: z.number().int().nonnegative(),
  precedence: z.tuple([z.literal('current_request'), z.literal('project'), z.literal('global')]),
  disclosure: z.string().min(1),
}).strict();
export const searchOutputSchema = z.object({
  matches: z.array(z.object({
    id: identifier, ...condition, scope: scopeSchema, source: sourceSchema, reason: proposalSchema.shape.reason,
    score: z.number().nonnegative(), matchedTerms: z.array(z.string()),
    matchedTopics: z.array(z.enum(['language', 'tone', 'format', 'audience', 'budget', 'deadline', 'brand', 'cta'])),
  }).strict()).max(50),
  omittedCount: z.number().int().nonnegative(), routing: routingSchema,
  searchedScopes: z.array(z.string()).min(1).max(2), retrieval: z.literal('local-lexical-topic-v2'),
}).strict();
export const proposalOutputSchema = z.object({ id: identifier, status: z.literal('candidate'), reviewRequired: z.literal(true) }).strict();
