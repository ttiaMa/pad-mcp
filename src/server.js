import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer, createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { KnowledgeError } from './store.js';
import { idSchema, powerFxSchema, importSchema, saveShape, searchShape } from './schema.js';
import { CatalogCache } from './catalog-cache.js';
import { actionLookup, typeLookup } from './catalog.js';
import { developmentPrompt } from './prompts.js';
import { ApiKeys } from './api-keys.js';
import { UsageStats } from './usage.js';
import { CallRateLimiter, DEFAULT_CALL_RATE_LIMIT_PER_MINUTE } from './rate-limit.js';

export const instructions = `Call get_development_context first. Ask the user to choose PAD Classic or Power Fx before supplying power_fx disabled or enabled. Pass the selected power_fx value to every development lookup and keep it unchanged throughout the chat. Development guidance is returned after selection.`;

export const authoringGuidance = [
  'Classify each entry as power_fx enabled, disabled, or either before publication. Use either only for explicitly established compatibility with both modes. Drafts may remain unspecified; do not infer compatibility or rewrite code to make it fit the current chat mode. Maintenance review can inspect entries from either mode.',
  'Before saving new knowledge, turn the supplied Robin and informal explanation (including voice transcriptions) into a concise, searchable entry. You, the connected agent, prepare the metadata; the server does not summarize it.',
  'Preserve robin_code exactly. Remove repetition and unrelated storytelling from metadata, but retain conditions, exceptions, final partial batches, datatypes and behavior that affect correct use.',
  'Write metadata in clear English unless the user requests another language. Use a short task-specific title; describe when to use the pattern and its expected result in 1-3 problem sentences. Summarize the mechanism and the author\'s stated rationale in approach without inventing reasons.',
  'Choose a focused area and about 3-8 relevant tags using likely search terms and useful synonyms. Include relevant synonyms supplied by the user or established by the team. Do not add unrelated keywords. Title, problem and tags receive higher search weight.',
  'Put inputs, outputs, edge cases and limitations in their dedicated fields rather than one long description. Omit unsupported inferences and avoid repeating the same fact across fields. Ask only when missing information is needed to identify or use the pattern correctly.',
  'Search for similar published patterns before creating a new ID; use list_patterns to check existing drafts when relevant. Do not silently merge or replace an existing entry. Split unrelated tasks only with the user\'s agreement and preserve the original submitted code.',
  'After save_draft, show the saved ID/revision and a compact review of title, problem, approach, tags and relevant constraints. State whether the original code is unchanged. Publish only when the user has approved that content; prior approval of the exact complete entry does not require redundant confirmation. Code-only approval does not approve newly inferred metadata.'
];

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function buildMcp(store, role, catalogCache, usage, keyId) {
  const server = new McpServer({ name: 'pad-mcp', version: '0.1.0' }, {
    instructions
  });
  function tool(name, description, inputSchema, readOnly, handler, annotations = {}) {
    server.registerTool(name, {
      description, inputSchema: Object.hasOwn(inputSchema, 'power_fx') ? z.strictObject(inputSchema) : z.object(inputSchema),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false, ...annotations }
    }, async args => {
      let success = false;
      let data;
      try { data = await handler(args); const response = result(data); success = true; return response; }
      catch (error) {
        if (!(error instanceof KnowledgeError)) console.error('Tool failed:', error);
        return { isError: true, content: [{ type: 'text', text: error instanceof KnowledgeError ? error.message : 'Operation failed. No successful write is confirmed; read the current state before retrying.' }] };
      } finally {
        if (role === 'developer') {
          const mode = args.power_fx === 'enabled' ? 'power_fx' : args.power_fx === 'disabled' ? 'classic' : 'not_applicable';
          const search = ['search_patterns', 'search_actions', 'search_type_reference'].includes(name);
          usage.record({ keyId, tool: name, mode, success,
            empty: search && (Array.isArray(data?.results) && data.results.length === 0 || data?.record === null) });
        }
      }
    });
  }

  tool('get_development_context', 'Start a chat by asking the user to choose Classic or Power Fx. Without arguments returns selection_required. With power_fx returns guidance without storing session state; reuse the selected power_fx in every development lookup. Includes compatible published global conventions.', {
    power_fx: powerFxSchema.optional()
  }, true, async args => {
    const context = store.developmentContext(args);
    if (context.status === 'selection_required') return context;
    let rules;
    let catalogError;
    try { rules = (await catalogCache.get(context.power_fx)).developmentRules(); }
    catch { catalogError = 'Catalog unavailable. Use compatible approved snippets where sufficient; reload this context before introducing catalog actions.'; }
    const maintenance = role === 'maintainer' ? {
      authoring_guidance: authoringGuidance
    } : {};
    return { ...context, development_prompt: developmentPrompt(context.power_fx, rules),
      ...store.context(role, context.power_fx), ...maintenance,
      ...(catalogError ? { catalog_error: catalogError } : {}) };
  });
  const catalogShape = {
    power_fx: powerFxSchema,
    query: z.string().trim().min(1).max(500).optional(),
    max_results: z.number().int().min(1).max(20).default(5)
  };
  async function catalogLookup(args, schema, method) {
    const { power_fx, ...lookup } = args;
    const parsed = schema.safeParse(lookup);
    if (!parsed.success) throw new KnowledgeError(parsed.error.issues.map(issue => issue.message).join('; '));
    let index;
    try { index = await catalogCache.get(power_fx); }
    catch { throw new KnowledgeError('Catalog unavailable: no valid catalog pair could be loaded. Approved snippet tools remain available; retry later.'); }
    return index[method](parsed.data);
  }
  tool('search_actions', 'Search the selected PAD edition by English technical keywords or module (category). Returns up to five compact matches by default. Then pass action_id alone for the complete action, parameters, examples, sibling selectors and constraints. Never invent selectors; use the same power_fx value throughout this chat.', {
    ...catalogShape, action_id: z.string().trim().min(1).max(300).optional(), module: z.string().trim().min(1).max(100).optional()
  }, true, args => catalogLookup(args, actionLookup, 'searchActions'));
  tool('search_type_reference', 'Search the selected PAD edition by type keywords, or pass an exact type_name (including generic notation) for full syntax, examples and formatting. General rules are in the development context. Reuse power_fx; results are reference data, not execution guarantees.', {
    ...catalogShape, type_name: z.string().trim().min(1).max(300).optional()
  }, true, args => catalogLookup(args, typeLookup, 'searchTypes'));
  tool('search_patterns', 'Find approved PAD patterns for development or for rebuilding parts of UiPath, Blue Prism and other RPA automations in PAD. Search by implementation need. Returns compact previews only. Retrieve a relevant result with get_pattern using its id and revision before reusing its code or applying its constraints. Drafts are excluded. Supports English and Italian queries.', searchShape, true,
    args => store.searchDevelopment(args, role));
  tool('get_pattern', 'Read the full compatible published pattern, including original Robin and constraints, using power_fx and the id/revision from search_patterns. If that revision is no longer published, search again. Maintainers may explicitly use purpose=maintenance without power_fx to review latest drafts or revision history across modes; maintenance results are not development references.', {
    id: idSchema, revision: z.number().int().positive().optional(),
    power_fx: powerFxSchema.optional(), purpose: z.enum(['development', 'maintenance']).default('development')
  }, true, args => {
    if (args.purpose === 'maintenance') {
      if (role !== 'maintainer') throw new KnowledgeError('Maintenance reads require the Maintainer role.');
      if (args.power_fx !== undefined) throw new KnowledgeError('Maintenance reads do not accept power_fx.');
      return { ...store.get(args.id, role, args.revision), purpose: 'maintenance' };
    }
    return store.getDevelopmentPattern(args);
  });
  tool('export_knowledge', 'Export a page of published entries as portable JSON. Follow next_offset to export more. Not a full database backup.', {
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(20)
  }, true, args => store.export(args));

  // Authorization is enforced by the server: developer connections do not register write handlers.
  if (role === 'maintainer') {
    tool('get_usage_stats', 'Read aggregate Developer tool usage stored on this instance. UTC daily counters only; excludes Maintainer activity and protocol traffic. Active keys are not necessarily unique people and successful calls do not prove PAD execution.', {
      days: z.number().int().min(1).max(365).default(30),
      group_by: z.enum(['day', 'tool', 'mode', 'key']).default('day'),
      key_id: z.string().uuid().optional(), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30)
    }, true, args => usage.report(args));
    tool('list_patterns', 'List IDs and latest revisions, including drafts, for managing the knowledge base. Read full content with get_pattern.', {
      status: z.enum(['all', 'draft', 'published']).default('all'),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20)
    }, true, args => store.list(args));
    tool('save_draft', 'Save a new immutable draft revision at the user request. First follow the authoring_guidance from get_development_context: distill informal or transcribed context into a task-specific title, concise problem/approach and relevant search tags; retain technical constraints in dedicated fields and preserve Robin exactly. Check for duplicates. Use expected_revision=0 for new IDs; otherwise read the latest revision first. Show the saved entry for review before publication. Omit unsupported inferences. The server stores your prepared metadata without AI summarization.', saveShape, false,
      args => store.saveDraft(args));
    tool('publish_revision', 'Publish the exact latest revision after explicit user approval of its content. Published entries are available to all authenticated users. Approval does not mean tested. If the user already requested approval of exact submitted content, no redundant approval is needed.', {
      id: idSchema, revision: z.number().int().positive()
    }, false, args => store.publish(args));
    tool('unpublish_pattern', 'Withdraw a pattern from search and developer access at the user request, retaining its revision history.', { id: idSchema }, false,
      args => store.unpublish(args.id));
    tool('replace_pattern', 'Replace an existing pattern with explicitly user-approved content and publish it atomically under the same ID. Preserve original Robin exactly. Prior revisions remain in maintainer-only history; developers and search receive the replacement immediately. Read the latest revision first. For unapproved changes use save_draft instead.', {
      ...saveShape,
      expected_revision: z.number().int().positive().describe('Latest revision read before replacement.'),
    }, false, args => store.replace(args));
    tool('delete_pattern', 'Permanently delete a pattern and ALL of its revisions from the live database and search index. Maintainer only. Use only when the user explicitly requests permanent deletion of this pattern. Read the exact ID and latest revision first. Use unpublish_pattern to retain history, or replace_pattern to publish an approved replacement.', {
      id: idSchema,
      expected_revision: z.number().int().positive().describe('Latest revision read before deletion.')
    }, false, args => store.delete(args));
    tool('import_knowledge', 'Upload a portable JSON package of up to 20 patterns. Imports only as drafts; never inherits approval. Existing IDs reject the entire batch. For a single pasted Robin block use save_draft.', {
      package: importSchema
    }, false, args => store.import(args.package));
  }
  return server;
}

export function validateConfig(config) {
  if (config.callRateLimitPerMinute !== undefined && (!Number.isSafeInteger(config.callRateLimitPerMinute) || config.callRateLimitPerMinute < 1)) {
    throw new Error('MCP_CALL_RATE_LIMIT_PER_MINUTE must be a positive safe integer.');
  }
  if (config.usageEnabled !== undefined && typeof config.usageEnabled !== 'boolean') throw new Error('USAGE_STATS_ENABLED must be true or false.');
  if (config.usageRetentionDays !== undefined && (!Number.isInteger(config.usageRetentionDays) || config.usageRetentionDays < 1 || config.usageRetentionDays > 365)) throw new Error('USAGE_RETENTION_DAYS must be an integer from 1 to 365.');
  if (!config.maintainerToken || config.maintainerToken.length < 32) throw new Error('MCP_MAINTAINER_TOKEN must contain at least 32 characters.');
  const url = new URL(config.publicUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_URL must be an HTTP(S) origin without credentials or path.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('PUBLIC_URL must use HTTPS except on localhost.');
  }
}

export function createApp(store, config, { catalogCache = new CatalogCache(), rateLimitNow } = {}) {
  validateConfig(config);
  const app = express();
  const usage = new UsageStats(store.db, { enabled: config.usageEnabled, retentionDays: config.usageRetentionDays });
  app.locals.usage = usage;
  usage.cleanup();
  app.disable('x-powered-by');
  const publicUrl = new URL(config.publicUrl);
  const allowedHosts = new Set([publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]']);
  const digest = value => createHash('sha256').update(value).digest();
  const maintainerDigest = digest(config.maintainerToken);
  const apiKeys = new ApiKeys(store.db);
  const callRateLimiter = new CallRateLimiter(config.callRateLimitPerMinute ?? DEFAULT_CALL_RATE_LIMIT_PER_MINUTE, { now: rateLimitNow });

  app.get('/healthz', (_req, res) => {
    try { store.health(); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/mcp', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!allowedHosts.has(req.hostname) || (req.headers.origin && req.headers.origin !== publicUrl.origin)) {
      return res.status(403).json({ error: 'Host or Origin not allowed.' });
    }
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match) return res.status(401).set('WWW-Authenticate', 'Bearer realm="pad-mcp"').json({ error: 'Bearer token required.' });
    const supplied = digest(match[1]);
    if (timingSafeEqual(supplied, maintainerDigest)) res.locals.role = 'maintainer';
    else {
      const key = apiKeys.authenticate(match[1]);
      if (!key) return res.status(401).set('WWW-Authenticate', 'Bearer realm="pad-mcp"').json({ error: 'Invalid token.' });
      res.locals.role = 'developer';
      res.locals.apiKeyId = key.id;
    }
    const retryAfter = callRateLimiter.consume(res.locals.role === 'maintainer' ? 'maintainer' : res.locals.apiKeyId);
    if (retryAfter) {
      return res.status(429).set('Retry-After', String(retryAfter)).json({
        error: 'MCP request rate limit exceeded. This request was not executed.', retry_after_seconds: retryAfter
      });
    }
    next();
  });
  app.post('/mcp', express.json({ limit: '2mb' }), async (req, res) => {
    const factory = () => buildMcp(store, res.locals.role, catalogCache, usage, res.locals.apiKeyId);
    const modern = createMcpHandler(factory, { legacy: 'reject' });
    try {
      await toNodeHandler({ fetch: async (request, options) => {
        if (!await isLegacyRequest(request, options?.parsedBody)) return modern.fetch(request, options);
        // Keep JSON responses for existing clients and raw HTTP integrations.
        const server = factory();
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
          await server.connect(transport);
          return await transport.handleRequest(request, options);
        } finally {
          await server.close();
        }
      } }, { onerror: error => console.error('MCP adapter failed:', error) })(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    } finally {
      await modern.close().catch(error => console.error('MCP close failed:', error));
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST. Stateless server has no SSE sessions.' }));
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    if (status === 500) console.error('HTTP request failed:', error);
    res.status(status).json({ error: status === 413 ? 'Request too large.' : status === 400 ? 'Invalid JSON.' : 'Internal error.' });
  });
  return app;
}
