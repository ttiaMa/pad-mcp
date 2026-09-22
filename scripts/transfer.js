import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { packageEntrySchema } from '../src/schema.js';

const [operation, file, ...flags] = process.argv.slice(2);
if (!['export', 'import'].includes(operation) || !file || flags.length) {
  console.error('Usage: npm run transfer -- export output.json | import input.json');
  process.exit(1);
}
const endpoint = process.env.MCP_URL ?? `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/mcp`;
const token = process.env.MCP_MAINTAINER_TOKEN;
if (!token) throw new Error('MCP_MAINTAINER_TOKEN is required.');
const client = new Client({ name: 'pad-mcp-transfer', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
});
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content?.find(item => item.type === 'text')?.text ?? 'Tool failed.');
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
try {
  // Validate the full input before initiating any writes.
  const pack = operation === 'import' ? z.object({
    schema_version: z.literal(1), entries: z.array(packageEntrySchema).max(10000)
  }).strict().parse(JSON.parse(await readFile(file, 'utf8'))) : null;
  if (pack && new Set(pack.entries.map(entry => entry.id)).size !== pack.entries.length) throw new Error('Duplicate IDs in package.');
  await client.connect(transport);
  if (operation === 'export') {
    const entries = [];
    let offset = 0;
    do {
      const page = await call('export_knowledge', { offset, limit: 20 });
      entries.push(...page.entries);
      offset = page.next_offset;
    } while (offset !== null);
    await writeFile(file, `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`Exported ${entries.length} published entries to ${file}.`);
  } else {
    for (let index = 0; index < pack.entries.length; index += 20) {
      await call('import_knowledge', { package: { schema_version: 1, entries: pack.entries.slice(index, index + 20) } });
      console.log(`Imported ${Math.min(index + 20, pack.entries.length)}/${pack.entries.length} as drafts.`);
    }
  }
} finally {
  await client.close();
}
