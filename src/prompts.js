import { readFileSync } from 'node:fs';

const common = readFileSync(new URL('./prompts/common.md', import.meta.url), 'utf8');
const modes = {
  disabled: readFileSync(new URL('./prompts/classic.md', import.meta.url), 'utf8'),
  enabled: readFileSync(new URL('./prompts/power-fx.md', import.meta.url), 'utf8')
};

export function developmentPrompt(mode, rules) {
  if (!Object.hasOwn(modes, mode)) throw new Error('Unknown development mode.');
  return `${common}\n\n${modes[mode]}${rules ? `\n\nCatalog rules for the selected mode:\n${JSON.stringify(rules)}` : ''}`;
}
