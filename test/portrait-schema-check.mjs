/**
 * Validates the portrait tool schemas against the runtime's OWN schema checker.
 *
 * `ctx.tools.register()` calls `assertSupportedJsonSchema(output.schema)` from
 * `@deepseek-ai/dsh-tools`, and rejects the shorthand `required: true` form. The
 * plugin cannot import that package at runtime (it lives outside the profile),
 * but a test can, so this imports the real checker by absolute path instead of
 * trusting a hand-written imitation.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { PLUGIN_ROOT, RUNTIME_TOOLS, skip } from './_paths.mjs';

const TOOLS_MODULE = join(PLUGIN_ROOT, 'lib', 'tools.js');
if (RUNTIME_TOOLS === undefined) skip('no DSH application found; set DSH_APP_ROOT to run the schema suite');

import { check, finish } from './_harness.mjs';

const runtime = await import(pathToFileURL(RUNTIME_TOOLS).href);
const assertSupportedJsonSchema = runtime.assertSupportedJsonSchema;
check('imported the runtime schema checker', typeof assertSupportedJsonSchema === 'function');

const module = await import(pathToFileURL(TOOLS_MODULE).href);
const tools = module.portraitTools({ ops: {} });
check('exports four tools', tools.length === 4, tools.length);

/** Run the real checker and capture its verdict. */
function verdict(schema) {
  try {
    assertSupportedJsonSchema(schema);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// Prove the checker is actually strict, so a pass below means something.
const shorthand = verdict({ type: 'object', properties: { text: { type: 'string', required: true } } });
check('the checker rejects the shorthand form this plugin used to emit', shorthand.ok === false, shorthand);
check('the shorthand rejection names the offending keyword', String(shorthand.message).includes('required'), shorthand.message);

const names = new Set();
for (const tool of tools) {
  const parameters = verdict(tool.parameters);
  check(`${tool.name}: parameters pass the runtime checker`, parameters.ok === true, parameters.message);
  const output = verdict(tool.output?.schema);
  check(`${tool.name}: output.schema passes the runtime checker`, output.ok === true, output.message);

  check(`${tool.name}: name is present and prefixed`, typeof tool.name === 'string' && tool.name.startsWith('portrait_'), tool.name);
  check(`${tool.name}: name is unique`, !names.has(tool.name), tool.name);
  names.add(tool.name);
  check(`${tool.name}: has a substantial description`, typeof tool.description === 'string' && tool.description.length > 20, (tool.description ?? '').length);
  check(`${tool.name}: is executable`, typeof tool.execute === 'function');
  check(`${tool.name}: renders its output`, typeof tool.output?.render === 'function');

  check(`${tool.name}: parameters are an object root`, tool.parameters?.type === 'object', tool.parameters?.type);
  check(`${tool.name}: parameters reject unknown keys`, tool.parameters?.additionalProperties === false, tool.parameters?.additionalProperties);
  check(`${tool.name}: output is an object root`, tool.output?.schema?.type === 'object', tool.output?.schema?.type);
  check(`${tool.name}: output rejects unknown keys`, tool.output?.schema?.additionalProperties === false);

  const required = tool.parameters?.required;
  if (required !== undefined) {
    check(`${tool.name}: required is an array of declared names`, Array.isArray(required) && required.every((key) => Object.hasOwn(tool.parameters.properties ?? {}, key)), required);
  }
  for (const [key, spec] of Object.entries(tool.parameters?.properties ?? {})) {
    check(`${tool.name}.${key}: declares a type`, typeof spec.type === 'string', spec.type);
    check(`${tool.name}.${key}: has no nested required flag`, !Object.hasOwn(spec, 'required'), spec);
    if (Array.isArray(spec.enum)) {
      check(`${tool.name}.${key}: every enum value matches the declared type`, spec.enum.every((value) => (spec.type === 'string' ? typeof value === 'string' : true)), spec.enum);
    }
  }
}

// Round-trip the arguments the model will actually send through the runtime
// validator, which is what dispatch does before calling execute.
const validateJsonSchemaValue = runtime.validateJsonSchemaValue;
const maintain = tools.find((tool) => tool.name === 'portrait_maintain');
check('a valid maintain call passes argument validation', validateJsonSchemaValue(maintain.parameters, { action: 'backfill' }, '').length === 0);
check('an unknown action is rejected', validateJsonSchemaValue(maintain.parameters, { action: 'nope' }, '').length > 0);
check('a missing required action is rejected', validateJsonSchemaValue(maintain.parameters, {}, '').length > 0);
check('an unknown extra key is rejected', validateJsonSchemaValue(maintain.parameters, { action: 'backfill', surprise: 1 }, '').length > 0);
const search = tools.find((tool) => tool.name === 'portrait_search');
check('a valid search call passes argument validation', validateJsonSchemaValue(search.parameters, { query: 'x' }, '').length === 0);
check('a missing search query is rejected', validateJsonSchemaValue(search.parameters, {}, '').length > 0);
const read = tools.find((tool) => tool.name === 'portrait_read');
check('a dimension filter passes argument validation', validateJsonSchemaValue(read.parameters, { dimension: 'skill' }, '').length === 0);
check('an unknown dimension is rejected', validateJsonSchemaValue(read.parameters, { dimension: 'nope' }, '').length > 0);
check('a retired dimension id stays readable', validateJsonSchemaValue(read.parameters, { dimension: 'tech' }, '').length === 0);
check('the enum announces the nine current dimensions first', read.parameters.properties.dimension.enum.slice(0, 9).includes('personality') && read.parameters.properties.dimension.enum.length > 9, read.parameters.properties.dimension.enum);
check('no-argument read passes argument validation', validateJsonSchemaValue(read.parameters, {}, '').length === 0);

finish('SCHEMA CHECK PASSED');
