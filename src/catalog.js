import { z } from 'zod';

const text = z.string().min(1);
const parameter = z.object({ name: text, type: text }).passthrough();
const action = z.object({
  actionId: text, module: text,
  kind: z.enum(['Action', 'Condition', 'Wait', 'While']),
  selector: z.string().nullable(), template: text, golden_example: text,
  input_params: z.array(parameter), output_params: z.array(parameter),
  constraints: z.record(z.unknown()), sibling_selectors: z.array(text),
  needs_ui_selector: z.boolean(), validation: text
}).passthrough();
const type = z.object({ type: text, category: text, example: text, description: text }).passthrough();
const header = z.object({
  name: text, version: text, license: z.literal('CC BY 4.0'),
  edition: z.string().optional()
}).passthrough();
const actionsSchema = header.extend({ pad_build: text, actions: z.array(action).min(1) });
const typesSchema = header.extend({ rules: z.array(text), types: z.array(type).min(1) });
const modeSchema = z.enum(['enabled', 'disabled']);
const lookup = {
  query: z.string().trim().min(1).max(500).optional(),
  max_results: z.number().int().min(1).max(20).default(5)
};
const actionLookup = z.object({
  ...lookup, action_id: text.optional(), module: text.optional()
}).strict().refine(a => a.action_id ? !a.query && !a.module : !!(a.query || a.module),
  'Supply action_id alone, or query and/or module.');
const typeLookup = z.object({ ...lookup, type_name: text.optional() }).strict()
  .refine(a => !!a.type_name !== !!a.query, 'Supply either type_name or query.');

export const CATALOG_REPOSITORY = 'https://github.com/JoeG592/pad-robin-action-kb';

export function catalogFiles(powerFx) {
  modeSchema.parse(powerFx);
  const suffix = powerFx === 'enabled' ? '_PowerFx' : '';
  return { actions: `PAD_Robin_ActionKB${suffix}.json`, types: `PAD_Robin_TypeReference${suffix}.json` };
}

function parseDocument(value, schema, powerFx) {
  const document = schema.parse(typeof value === 'string' ? JSON.parse(value) : structuredClone(value));
  if (powerFx === 'enabled' ? document.edition !== 'power-fx' : document.edition !== undefined && document.edition !== 'classic') {
    throw new Error('Catalog edition does not match the requested Power Fx mode.');
  }
  return document;
}

function unique(records, key) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record[key])) throw new Error(`Duplicate catalog identifier: ${record[key]}`);
    ids.add(record[key]);
  }
}

/** Parse a complete same-edition pair. Unknown upstream fields are preserved. */
export function parseCatalogPair({ actions, types, power_fx }) {
  modeSchema.parse(power_fx);
  const actionDocument = parseDocument(actions, actionsSchema, power_fx);
  const typeDocument = parseDocument(types, typesSchema, power_fx);
  unique(actionDocument.actions, 'actionId');
  unique(typeDocument.types, 'type');
  return { power_fx, actions: actionDocument, types: typeDocument };
}

function normalize(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').normalize('NFKC').toLowerCase();
}
function terms(value) { return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []; }
function indexRecord(record, id, fields) {
  return { record, id, tokens: new Set(terms(fields.join(' '))) };
}
function compareIds(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
function rank(records, query) {
  if (!query) return records.slice().sort(compareIds);
  const tokens = [...new Set(terms(query))];
  if (!tokens.length) return [];
  return records.map(item => ({
    ...item,
    score: item.id.toLowerCase() === query.toLowerCase() ? 1000 :
      tokens.reduce((score, token) => score + (item.tokens.has(token) ? 1 : 0), 0)
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || compareIds(a, b));
}

/** Local lookup only: no network, persistence, or changes to approved knowledge. */
export class CatalogIndex {
  #pair;
  #actions;
  #types;
  #source;

  constructor(input, { commit = null, checked_at = null, cache_status = 'not_managed', refresh_error = null } = {}) {
    this.#pair = parseCatalogPair(input);
    this.#source = { repository: CATALOG_REPOSITORY, commit, checked_at, cache_status,
      ...(refresh_error ? { refresh_error } : {}) };
    this.#actions = this.#pair.actions.actions.map(record => indexRecord(record, record.actionId, [
      record.actionId, record.module, record.selector ?? '', record.description ?? '',
      ...record.input_params.flatMap(p => [p.name, p.type]),
      ...record.output_params.flatMap(p => [p.name, p.type])
    ]));
    this.#types = this.#pair.types.types.map(record => indexRecord(record, record.type,
      [record.type, record.category, record.description]));
  }

  #metadata(kind) {
    return { ...this.#source, power_fx: this.#pair.power_fx,
      file: catalogFiles(this.#pair.power_fx)[kind], version: this.#pair[kind].version,
      pad_build: this.#pair.actions.pad_build, license: this.#pair[kind].license };
  }

  searchActions(args) {
    const { action_id, query, module, max_results } = actionLookup.parse(args);
    const source = this.#metadata('actions');
    if (action_id) {
      const record = this.#actions.find(item => item.id === action_id)?.record;
      return structuredClone({ source, record: record ?? null });
    }
    const candidates = module ? this.#actions.filter(item => item.record.module.toLowerCase() === module.toLowerCase()) : this.#actions;
    const matches = rank(candidates, query);
    return { source, total_matches: matches.length, truncated: matches.length > max_results,
      results: matches.slice(0, max_results).map(({ record }) => ({
        actionId: record.actionId, module: record.module, kind: record.kind, selector: record.selector,
        input_names: record.input_params.map(p => p.name),
        output_names: record.output_params.map(p => p.name), needs_ui_selector: record.needs_ui_selector
      })) };
  }

  searchTypes(args) {
    const { type_name, query, max_results } = typeLookup.parse(args);
    const source = this.#metadata('types');
    if (type_name) {
      const record = this.#types.find(item => item.id === type_name)?.record;
      return structuredClone({ source, record: record ?? null, rules: this.#pair.types.rules });
    }
    const matches = rank(this.#types, query);
    return { source, total_matches: matches.length, truncated: matches.length > max_results,
      results: matches.slice(0, max_results).map(({ record }) => ({
        type: record.type, category: record.category, description: record.description
      })) };
  }
}
