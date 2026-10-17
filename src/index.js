import { KnowledgeStore } from './store.js';
import { bootstrapKnowledge } from './bootstrap.js';
import { createApp, validateConfig } from './server.js';
import { dirname, join } from 'node:path';
import { CatalogCache } from './catalog-cache.js';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const databasePath = process.env.DATABASE_PATH ?? './data/knowledge.sqlite';
const config = {
  catalogCachePath: process.env.CATALOG_CACHE_PATH || join(dirname(databasePath), 'catalog-cache'),
  maintainerToken: process.env.MCP_MAINTAINER_TOKEN,
  usageEnabled: process.env.USAGE_STATS_ENABLED === undefined ? true
    : process.env.USAGE_STATS_ENABLED === 'true' ? true : process.env.USAGE_STATS_ENABLED === 'false' ? false : null,
  usageRetentionDays: Number(process.env.USAGE_RETENTION_DAYS ?? 90),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`
};
validateConfig(config);
const store = new KnowledgeStore(databasePath);
try {
  const bootstrap = bootstrapKnowledge(store);
  console.log(`Knowledge bootstrap: ${bootstrap.status}; ${bootstrap.entries} entries loaded.`);
} catch (error) {
  store.close();
  throw error;
}
const catalogCache = new CatalogCache({ directory: config.catalogCachePath });
catalogCache.start();
const app = createApp(store, config, { catalogCache });
const usageCleanup = setInterval(() => app.locals.usage.cleanup(), 60 * 60 * 1000);
usageCleanup.unref();
const listener = app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`pad-mcp ready on port ${port}; MCP endpoint: ${config.publicUrl}/mcp`);
});
listener.on('error', error => { console.error(error); clearInterval(usageCleanup); catalogCache.stop(); store.close(); process.exitCode = 1; });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(usageCleanup);
  catalogCache.stop();
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  listener.close(() => { store.close(); clearTimeout(timer); });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
