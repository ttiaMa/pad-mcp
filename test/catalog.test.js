import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogIndex, parseCatalogPair, catalogFiles } from '../src/catalog.js';

// Synthetic, reduced records shaped like the upstream documents; not PAD-tested code.
function fixture(power_fx = 'disabled') {
  const header = { name: 'Synthetic catalog', version: '1', license: 'CC BY 4.0',
    ...(power_fx === 'enabled' ? { edition: 'power-fx' } : {}) };
  const actions = Array.from({ length: 7 }, (_, i) => ({
    actionId: `Text.JoinText.Variant${i}`, module: 'Text', kind: 'Action', selector: `Variant${i}`,
    template: 'Synthetic template', golden_example: `${power_fx} example ${i}`,
    input_params: [{ name: 'List', type: 'List`1<String>', required: true },
      { name: 'Delimiter', type: 'String', enumValues: ['Space', 'NewLine'] }],
    output_params: [{ name: 'Result', type: 'String', defaultVariable: 'JoinedText' }],
    constraints: { DelimiterType: 'Standard' }, sibling_selectors: ['Text.JoinText.Variant0'],
    needs_ui_selector: i === 6, validation: 'Synthetic fixture only', extra: { retained: true }
  }));
  actions.push({ ...actions[0], actionId: 'Excel.ReadCells', module: 'Excel', selector: null });
  return { power_fx, actions: { ...header, pad_build: '2.73', actions },
    types: { ...header, version: '2', rules: ['Synthetic type rule'], types: [
      { type: 'String', category: 'value', example: `${power_fx} string`, description: 'Text value', format: 'preserve this' },
      { type: 'List`1<String>', category: 'collection', example: 'List', description: 'List of text values' }
    ] } };
}

test('parses JSON pairs without requiring equal versions and preserves extra fields', () => {
  const input = fixture();
  const pair = parseCatalogPair({ ...input, actions: JSON.stringify(input.actions), types: JSON.stringify(input.types) });
  assert.deepEqual(pair, input);
  assert.deepEqual(catalogFiles('enabled'), {
    actions: 'PAD_Robin_ActionKB_PowerFx.json', types: 'PAD_Robin_TypeReference_PowerFx.json'
  });
});

test('rejects invalid JSON, incomplete structures, duplicates, empty and mixed-edition catalogs', () => {
  assert.throws(() => parseCatalogPair({ ...fixture(), actions: '{' }));
  for (const change of [
    f => { f.actions.actions = []; },
    f => { delete f.actions.actions[0].golden_example; },
    f => { f.actions.actions.push(f.actions.actions[0]); },
    f => { f.types.types.push(f.types.types[0]); },
    f => { f.types.edition = 'power-fx'; },
    f => { f.power_fx = 'unspecified'; }
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => parseCatalogPair(input));
  }
  const input = fixture('enabled'); delete input.actions.edition;
  assert.throws(() => parseCatalogPair(input));
});

test('action search is compact, bounded, deterministic and supports module-only browsing', () => {
  const index = new CatalogIndex(fixture());
  const result = index.searchActions({ query: 'join text', module: 'text' });
  assert.equal(result.results.length, 5);
  assert.equal(result.total_matches, 7);
  assert.equal(result.truncated, true);
  assert.equal(result.results[0].actionId, 'Text.JoinText.Variant0');
  assert.equal('golden_example' in result.results[0], false);
  assert.equal('template' in result.results[0], false);
  assert.equal(index.searchActions({ module: 'Excel' }).results[0].actionId, 'Excel.ReadCells');
  assert.deepEqual(index.searchActions({ query: 'unfindable' }).results, []);
  assert.deepEqual(index.searchActions({ query: '***' }).results, []);
  assert.equal(index.searchActions({ query: 'Text.JoinText.Variant5' }).results[0].actionId, 'Text.JoinText.Variant5');
  assert.equal(index.searchActions({ module: 'Text', max_results: 20 }).results.length, 7);
});

test('exact lookup returns the complete original record, without provenance or fabricated matches', () => {
  const input = fixture();
  const index = new CatalogIndex(input);
  const result = index.searchActions({ action_id: 'Text.JoinText.Variant6' });
  assert.deepEqual(result.record, input.actions.actions[6]);
  assert.equal('source' in result, false);
  assert.equal(index.searchActions({ action_id: 'text.jointext.variant6' }).record, null);
  result.record.extra.retained = false;
  input.actions.actions[6].extra.retained = false;
  assert.equal(index.searchActions({ action_id: 'Text.JoinText.Variant6' }).record.extra.retained, true);
});

test('type lookup supports generic names, compact keyword search and complete formatting rules', () => {
  const index = new CatalogIndex(fixture());
  const result = index.searchTypes({ type_name: 'List`1<String>' });
  assert.equal(result.record.type, 'List`1<String>');
  assert.deepEqual(Object.keys(result), ['record']);
  assert.deepEqual(index.developmentRules(), { types: ['Synthetic type rule'] });
  assert.equal(index.searchTypes({ query: 'String' }).results[0].type, 'String');
  assert.equal('example' in index.searchTypes({ query: 'text' }).results[0], false);
  assert.equal(index.searchTypes({ type_name: 'Missing' }).record, null);
  assert.equal(index.searchTypes({ type_name: 'String' }).record.format, 'preserve this');
});

test('Classic and Power Fx indexes never share examples or metadata', () => {
  for (const mode of ['enabled', 'disabled']) {
    const index = new CatalogIndex(fixture(mode));
    assert.equal(index.searchActions({ action_id: 'Text.JoinText.Variant0' }).record.golden_example, `${mode} example 0`);
    assert.equal(index.searchTypes({ type_name: 'String' }).record.example, `${mode} string`);
    assert.equal('source' in index.searchTypes({ query: 'text' }), false);
  }
});

test('rejects ambiguous, unbounded or empty lookup requests', () => {
  const index = new CatalogIndex(fixture());
  for (const args of [{}, { query: ' ' }, { query: 'text', max_results: 21 },
    { action_id: 'id', query: 'text' }, { action_id: 'id', module: 'Text' }, { query: 'text', unknown: true }]) {
    assert.throws(() => index.searchActions(args));
  }
  for (const args of [{}, { type_name: 'String', query: 'text' }, { query: 'text', max_results: 0 }]) {
    assert.throws(() => index.searchTypes(args));
  }
});
