import { z } from 'zod';

export const idSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/);
const shortText = z.string().max(2000);
const notes = z.array(shortText).max(30).default([]);

export const contentSchema = z.object({
  kind: z.enum(['snippet', 'convention', 'recipe']).default('snippet'),
  title: z.string().trim().min(1).max(200).describe('Short task-specific title using likely search terms, e.g. Split a list into fixed-size batches. Avoid generic labels.'),
  problem: z.string().trim().min(1).max(8000).describe('Summarize when this pattern is useful and the expected result, ideally in 1-3 sentences. Retain conditions that distinguish it from similar patterns; do not paste the conversation transcript.'),
  approach: z.string().max(8000).default('').describe('Briefly explain the mechanism and the author\'s stated reason for using it. Do not invent rationale or repeat the full code.'),
  // Never trim or normalize the submitted Robin code.
  robin_code: z.string().max(64000).default('').describe('Exact submitted Robin code, including whitespace and comments. Never rewrite or translate it while preparing metadata.'),
  area: z.string().trim().min(1).max(100).default('general').describe('Focused topic such as lists, excel or error-handling; use global for conventions needed at the start of every task.'),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]).describe('Prefer 3-8 specific search terms and useful synonyms. Include relevant team vocabulary; avoid unrelated keyword stuffing.'),
  power_fx: z.enum(['enabled', 'disabled', 'either', 'unspecified']).default('unspecified'),
  inputs: notes.describe('Required input values and datatypes supported by the supplied explanation or code.'),
  outputs: notes.describe('Produced values and datatypes; preserve important edge-case behavior.'),
  pitfalls: notes.describe('Known limitations and edge cases stated by the author. Do not add speculative concerns.')
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'snippet' && !value.robin_code.trim()) {
    ctx.addIssue({ code: 'custom', path: ['robin_code'], message: 'A snippet requires Robin code.' });
  }
});

export const saveShape = {
  id: idSchema.describe('Stable slug. Use the same ID when updating a pattern.'),
  expected_revision: z.number().int().min(0).describe('0 for a new pattern; otherwise its latest revision.'),
  content: contentSchema
};

export const packageEntrySchema = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  content: contentSchema
}).strict();

export const importSchema = z.object({
  schema_version: z.literal(2),
  entries: z.array(packageEntrySchema).min(1).max(20)
}).strict();

export const searchShape = {
  query: z.string().trim().min(1).max(500),
  area: z.string().max(100).optional(),
  kind: z.enum(['snippet', 'convention', 'recipe']).optional(),
  power_fx: z.enum(['enabled', 'disabled']).optional(),
  max_results: z.number().int().min(1).max(10).default(3)
};
