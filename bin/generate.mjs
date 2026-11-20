/** VERIFIED: Generate a sidecar from static signatures without loading or executing the application. */
import ts from 'typescript';
import { resolve, relative, dirname, extname } from 'node:path';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const usage =
  'defuss-mcp --entry math.ts --out math.mcp.ts [--project tsconfig.json] [--only add,subtract] [--check]';
const format = (ds) =>
  ts.formatDiagnostics(ds, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  });

/** Resolve the input project, type-check without executing it, then check or atomically replace a sidecar. */
export async function generateContracts(args) {
  const { values } = parseArgs({
    args,
    options: {
      entry: { type: 'string' },
      out: { type: 'string' },
      project: { type: 'string' },
      only: { type: 'string' },
      check: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.entry || !values.out) throw Error(usage);
  const entry = resolve(values.entry),
    out = resolve(values.out);
  if (entry === out || !/\.(ts|mts|mjs)$/.test(out))
    throw Error('Choose a separate .ts, .mts or .mjs output module');
  let options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  };
  const config = values.project
    ? resolve(values.project)
    : ts.findConfigFile(dirname(entry), ts.sys.fileExists);
  if (config) {
    const file = ts.readConfigFile(config, ts.sys.readFile);
    if (file.error) throw Error(format([file.error]));
    const parsed = ts.parseJsonConfigFileContent(file.config, ts.sys, dirname(config));
    const errors = parsed.errors.filter((e) => e.code !== 18003);
    if (errors.length) throw Error(format(errors));
    options = { ...options, ...parsed.options };
  }
  const program = ts.createProgram([entry], {
    ...options,
    strictNullChecks: true,
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const file = program.getSourceFile(entry);
  if (!file || file.isDeclarationFile) throw Error('Supply a runtime source module: ' + entry);
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw Error(format(errors));
  const checker = program.getTypeChecker(),
    mod = checker.getSymbolAtLocation(file);
  if (!mod) throw Error('Entry must be a module with named function exports');
  const doc = (s) => ts.displayPartsToString(s.getDocumentationComment(checker));
  const flag = (t, f) => (t.flags & f) !== 0;
  const optionalType = (type, optional) => {
    if (!optional || !type.isUnion()) return type;
    const remaining = type.types.filter((t) => !flag(t, ts.TypeFlags.Undefined));
    return remaining.length === 1 ? remaining[0] : type;
  };
  // Keep the ancestor set path-local: a shared interface in siblings is representable, a recursive one is not.
  function schema(type, path, seen = new Set(), optional = false) {
    type = optionalType(type, optional);
    const unsupported = () => {
      throw Error(
        path +
          ': unsupported type ' +
          checker.typeToString(type) +
          '. Use a concrete JSON/Uint8Array signature or keep this function on DSON.',
      );
    };
    if (seen.has(type) || seen.size > 48) unsupported();
    const next = new Set([...seen, type]);
    if (flag(type, ts.TypeFlags.Boolean)) return { type: 'boolean' };
    if (type.isUnion()) {
      const members = type.types.filter((t) => !optional || !flag(t, ts.TypeFlags.Undefined));
      const present = members.filter((t) => !flag(t, ts.TypeFlags.Null));
      if (present.length && present.length !== members.length) {
        let base;
        if (present.length === 1) base = schema(present[0], path, next);
        else if (present.every((t) => flag(t, ts.TypeFlags.BooleanLiteral))) base = { type: 'boolean' };
        else if (present.every((t) => t.isStringLiteral()) || present.every((t) => t.isNumberLiteral()))
          base = {
            type: present[0].isStringLiteral() ? 'string' : 'number',
            enum: present.map((t) => t.value),
          };
        else unsupported();
        return { ...base, type: [base.type, 'null'], ...(base.enum ? { enum: [...base.enum, null] } : {}) };
      }
      if (
        members.length &&
        (members.every((t) => t.isStringLiteral()) || members.every((t) => t.isNumberLiteral()))
      )
        return {
          type: members[0].isStringLiteral() ? 'string' : 'number',
          enum: members.map((t) => t.value),
        };
      if (optional && members.length === 2 && members.every((t) => flag(t, ts.TypeFlags.BooleanLiteral)))
        return { type: 'boolean' };
      unsupported();
    }
    if (type.isStringLiteral() || type.isNumberLiteral())
      return { type: type.isStringLiteral() ? 'string' : 'number', enum: [type.value] };
    if (flag(type, ts.TypeFlags.BooleanLiteral))
      return { type: 'boolean', enum: [type.intrinsicName === 'true'] };
    if (flag(type, ts.TypeFlags.String)) return { type: 'string' };
    if (flag(type, ts.TypeFlags.Number)) return { type: 'number' };
    if (flag(type, ts.TypeFlags.Null)) return { type: 'null' };
    const symbol = type.getSymbol();
    if (
      symbol?.name === 'Uint8Array' &&
      symbol.declarations?.some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
    )
      return { type: 'string', contentEncoding: 'base64', description: 'Canonical padded base64 bytes.' };
    if (checker.isArrayType(type))
      return { type: 'array', items: schema(checker.getTypeArguments(type)[0], path + '[]', next) };
    if (
      !flag(type, ts.TypeFlags.Object) ||
      checker.isTupleType(type) ||
      type.getCallSignatures().length ||
      checker.getIndexInfosOfType(type).length ||
      !symbol ||
      symbol.declarations?.some(
        (d) => ts.isClassDeclaration(d) || program.isSourceFileDefaultLibrary(d.getSourceFile()),
      )
    )
      unsupported();
    const properties = Object.create(null),
      required = [];
    for (const prop of type.getProperties()) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      if (
        !decl ||
        prop.name.startsWith('__@') ||
        ts.isMethodSignature(decl) ||
        ts.isMethodDeclaration(decl) ||
        ts.isAccessor(decl)
      )
        unsupported();
      const opt = Boolean(prop.flags & ts.SymbolFlags.Optional);
      properties[prop.name] = schema(
        checker.getTypeOfSymbolAtLocation(prop, decl),
        path + '.' + prop.name,
        next,
        opt,
      );
      if (doc(prop)) properties[prop.name].description = doc(prop);
      if (!opt) required.push(prop.name);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  const only = values.only?.split(','),
    contracts = Object.create(null);
  for (const item of checker.getExportsOfModule(mod)) {
    const name = item.name;
    if (only && !only.includes(name)) continue;
    const sym = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
    if (!(sym.flags & ts.SymbolFlags.Value)) continue;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    const signatures = checker.getTypeOfSymbolAtLocation(sym, decl).getCallSignatures();
    if (!signatures.length) continue;
    if (!/^[$A-Z_a-z][$\w]*$/.test(name) || name === 'default' || name === 'contracts')
      throw Error('Use a named export other than contracts: ' + name);
    const sig = signatures[0];
    if (signatures.length !== 1 || sig.typeParameters?.length || sig.thisParameter)
      throw Error(name + ': overloaded, generic and explicit-this signatures need a concrete adapter');
    const parameters = [],
      properties = Object.create(null),
      required = [];
    let rest;
    for (const param of sig.getParameters()) {
      const d = param.valueDeclaration;
      if (!d || !ts.isParameter(d) || !ts.isIdentifier(d.name)) throw Error(name + ': use named parameters');
      const key = d.name.text,
        opt = Boolean(
          d.questionToken ||
            d.initializer ||
            d.dotDotDotToken ||
            param.flags & ts.SymbolFlags.Optional ||
            checker.isOptionalParameter(d),
        );
      if (d.dotDotDotToken) rest = key;
      parameters.push(key);
      properties[key] = schema(checker.getTypeOfSymbolAtLocation(param, d), name + '.' + key, new Set(), opt);
      if (doc(param)) properties[key].description = doc(param);
      if (!opt) required.push(key);
    }
    const result = checker.getAwaitedType(sig.getReturnType());
    const empty = result && flag(result, ts.TypeFlags.Void | ts.TypeFlags.Undefined);
    const resultProps = empty ? {} : { value: schema(result, name + ' return') };
    const rd = sig.getJsDocTags().find((t) => t.name === 'returns' || t.name === 'return');
    if (!empty && rd?.text) {
      const description = ts.displayPartsToString(rd.text);
      if (description) resultProps.value.description = description;
    }
    contracts[name] = {
      description: ts.displayPartsToString(sig.getDocumentationComment(checker)) || doc(sym) || undefined,
      parameters,
      rest,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: resultProps,
        required: empty ? [] : ['value'],
        additionalProperties: false,
      },
    };
  }
  if (!Object.keys(contracts).length || only?.some((name) => !Object.hasOwn(contracts, name)))
    throw Error('No matching named function export for ' + (values.only ?? entry));
  // Type stripping (Node, Bun) needs the source extension; the two options mark such a project.
  const sourceExtension = options.allowImportingTsExtensions || options.rewriteRelativeImportExtensions;
  let spec = relative(dirname(out), entry).replaceAll('\\', '/');
  if (!sourceExtension)
    spec = spec.replace(/\.(mts|cts|tsx?)$/, (_m, e) => (e === 'mts' ? '.mjs' : e === 'cts' ? '.cjs' : '.js'));
  if (!spec.startsWith('./') && !spec.startsWith('../')) spec = './' + spec;
  // A computed key preserves a literal __proto__ field in an otherwise plain, reviewable object.
  const literal = JSON.stringify(contracts, null, 2).replace(/^(\s*)"__proto__":/gm, '$1["__proto__"]:');
  const typed = extname(out) !== '.mjs';
  const names = Object.keys(contracts);
  const source = [
    '// VERIFIED: Generated by defuss-mcp. Regenerate from the source module.',
    "import { bindContract as __bind } from 'defuss-mcp';",
    'import * as __source from ' + JSON.stringify(spec) + ';',
    'const __contracts = ' +
      literal +
      (typed ? ' satisfies Record<string, import("defuss-mcp").FunctionContract>' : '') +
      ';',
    'export { __contracts as contracts };',
    ...names.map(
      (name, i) =>
        'const __fn' +
        i +
        ' = __bind(__source[' +
        JSON.stringify(name) +
        '], __contracts[' +
        JSON.stringify(name) +
        ']' +
        (typed ? '!' : '') +
        ');\nexport { __fn' +
        i +
        ' as ' +
        name +
        ' };',
    ),
    '',
  ].join('\n');
  if (values.check) {
    const { readFile } = await import('node:fs/promises');
    if ((await readFile(out, 'utf8')) !== source) throw Error('Stale generated contracts: ' + out);
  } else {
    await mkdir(dirname(out), { recursive: true });
    const tmp = out + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, source, { flag: 'wx' });
      await rename(tmp, out);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
