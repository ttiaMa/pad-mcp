import { parseArgs } from 'node:util';
import { KnowledgeStore } from '../src/store.js';
import { ApiKeys } from '../src/api-keys.js';

const usage = 'Usage: npm run keys -- create --name "Name" | list | delete --id <ID>';
let store;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { name: { type: 'string' }, id: { type: 'string' }, help: { type: 'boolean' } }
  });
  const [command] = positionals;
  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length !== 1 || !['create', 'list', 'delete'].includes(command)
      || (command === 'create' && (!values.name || values.id !== undefined))
      || (command === 'delete' && (!values.id || values.name !== undefined))
      || (command === 'list' && (values.name !== undefined || values.id !== undefined))) throw new Error(usage);
    store = new KnowledgeStore(process.env.DATABASE_PATH ?? './data/knowledge.sqlite');
    const keys = new ApiKeys(store.db);
    const output = command === 'create' ? keys.create(values.name)
      : command === 'delete' ? keys.delete(values.id) : keys.list();
    console.log(JSON.stringify(output, null, 2));
    if (command === 'create') console.error('Save this token now. It cannot be retrieved again.');
  }
} catch (error) {
  // Do not echo arbitrary arguments or database errors which may contain secrets.
  console.error(error.message === usage || /^(Name must|API key not found)/.test(error.message)
    ? error.message : 'Key command failed. Check arguments and database access. Use --help for usage.');
  process.exitCode = 1;
} finally { store?.close(); }
