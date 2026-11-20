/** VERIFIED: Schema compilation happens during tool registration. Calls reuse the validator and receive input-path corrections. */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv, type ErrorObject } from 'ajv';
import formats from 'ajv-formats';
import type { CompileSchema, Correction } from './index.js';

function pointer(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
function correction(error: ErrorObject): Correction {
  let path = error.instancePath;
  const { keyword, params } = error;
  let instruction = error.message ?? 'Check the declared schema';
  if (keyword === 'required') {
    path += '/' + pointer(params.missingProperty);
    instruction = 'Add this required field';
  } else if (keyword === 'additionalProperties') {
    path += '/' + pointer(params.additionalProperty);
    instruction = 'Remove this unexpected field';
  } else if (keyword === 'enum') {
    instruction = 'Use one of ' + JSON.stringify(params.allowedValues);
  } else if (keyword === 'const') {
    instruction = 'Use ' + JSON.stringify(params.allowedValue);
  } else if (keyword === 'type') {
    instruction = 'Supply type ' + JSON.stringify(params.type);
  }
  return { path, keyword, instruction, expected: params };
}

// The two shared engines see only the built-in dialects as schemas to compile.
// Application $id, $ref resolution and generated validator lifetimes stay registry-local.
let meta2020: Ajv2020 | undefined;
let meta07: Ajv | undefined;

/** Build a synchronous validator compiler for trusted application schemas. Uses draft 2020-12 by default or explicit draft-07. Compiled schemas are cached within this compiler. Invalid input returns up to 16 pointer-based corrections without type coercion. */
export function ajvValidator(): CompileSchema {
  const options = {
    allErrors: true,
    strict: false,
    ownProperties: true,
    addUsedSchema: false,
    validateSchema: false,
  };
  let modern: Ajv2020 | undefined;
  let draft7: Ajv | undefined;
  const compiled = new Map<string, ReturnType<CompileSchema>>();
  const addFormats = typeof formats === 'function' ? formats : formats.default;

  return (schema) => {
    if (schema.$async) throw new Error('Async schemas are unsupported.');
    // Registry schemas are defensive copies. Ajv's identity cache misses equivalent copies.
    const key = JSON.stringify(schema);
    const cached = compiled.get(key);
    if (cached) return cached;
    const classic = String(schema.$schema ?? '').includes('draft-07');
    const meta = classic
      ? (meta07 ??= addFormats(
          new Ajv({ strict: false, allErrors: true, ownProperties: true, addUsedSchema: false }),
        ))
      : (meta2020 ??= addFormats(
          new Ajv2020({ strict: false, allErrors: true, ownProperties: true, addUsedSchema: false }),
        ));
    meta.validateSchema(schema, true);
    const engine = classic
      ? (draft7 ??= addFormats(new Ajv(options)))
      : (modern ??= addFormats(new Ajv2020(options)));
    const validate = engine.compile(structuredClone(schema));
    const check: ReturnType<CompileSchema> = (value) =>
      validate(value) ? undefined : (validate.errors ?? []).slice(0, 16).map(correction);
    compiled.set(key, check);
    return check;
  };
}
