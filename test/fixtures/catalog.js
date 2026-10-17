import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { catalogFiles } from '../../src/catalog.js';

export function documents(mode, version) {
  const header = { name: 'Synthetic', license: 'CC BY 4.0', version,
    ...(mode === 'enabled' ? { edition: 'power-fx' } : {}) };
  return {
    actions: { ...header, pad_build: '2.73',
      ...(mode === 'enabled' ? { power_fx: { run_time_traps: ['Synthetic runtime caveat'] } } : {}),
      actions: Array.from({ length: 7 }, (_, i) => ({
        actionId: `Text.Action${i}`, module: 'Text', kind: 'Action', selector: null,
        template: 'Synthetic', golden_example: `${mode}-${version}`, input_params: [], output_params: [],
        constraints: {}, sibling_selectors: [], needs_ui_selector: false, validation: 'Synthetic only'
      })) },
    types: { ...header, rules: ['Synthetic rule'], types: [
      { type: 'String', category: 'value', example: `${mode}-${version}`, description: 'Text' }
    ] }
  };
}

export async function writeBundle(directory, version = 'a') {
  await fs.mkdir(directory, { recursive: true });
  const checksums = {};
  for (const mode of ['disabled', 'enabled']) {
    for (const [kind, file] of Object.entries(catalogFiles(mode))) {
      const bytes = JSON.stringify(documents(mode, version)[kind]);
      checksums[file] = createHash('sha256').update(bytes).digest('hex');
      await fs.writeFile(join(directory, file), bytes);
    }
  }
  await fs.writeFile(join(directory, 'metadata.json'), JSON.stringify({
    commit: version.repeat(40), downloaded_at: '2026-10-17T00:00:00Z', checksums
  }));
}
