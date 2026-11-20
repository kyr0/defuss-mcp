/** VERIFIED: Inspect the declaration files editors actually load through each package export. */
import ts from 'typescript';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
type Route = Record<'import' | 'require', { types: string }>;
const rows: { format: string; entry: string; name: string; summary: string }[] = [];
for (const format of ['import', 'require'] as const) {
  const files = Object.entries(manifest.exports as Record<string, Route>).map(
    ([entry, route]) => [entry, route[format].types] as const,
  );
  const program = ts.createProgram(
    files.map(([, path]) => path),
    {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  const record = (entry: string, name: string, symbol: ts.Symbol | undefined) => {
    const summary = ts.displayPartsToString(symbol?.getDocumentationComment(checker)).trim();
    if (!summary) throw Error('Missing declaration documentation: ' + format + ' ' + entry + ' ' + name);
    rows.push({ format, entry, name, summary });
  };
  for (const [entry, path] of files) {
    const file = program.getSourceFile(path);
    if (!file) throw Error('Missing declaration file ' + path);
    for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(file)!)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      record(entry, exported.name, symbol);
      for (const decl of symbol.declarations ?? []) {
        if (
          ts.isFunctionDeclaration(decl) &&
          symbol.declarations!.length > 1 &&
          !ts.getJSDocCommentsAndTags(decl).length
        )
          throw Error('Undocumented overload ' + exported.name);
        if (!ts.isInterfaceDeclaration(decl) && !ts.isClassDeclaration(decl)) continue;
        for (const member of decl.members) {
          if (ts.isConstructorDeclaration(member)) {
            if (!ts.getJSDocCommentsAndTags(member).length)
              throw Error('Undocumented constructor ' + symbol.name);
          } else if (
            member.name &&
            !ts.isPrivateIdentifier(member.name) &&
            (ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isPropertySignature(member))
          ) {
            record(
              entry,
              exported.name + '.' + member.name.getText(),
              checker.getSymbolAtLocation(member.name),
            );
          }
        }
      }
    }
  }
}
mkdirSync('output', { recursive: true });
writeFileSync('output/api-docs.json', JSON.stringify(rows, null, 2) + '\n');
console.log(rows.length + ' documented declarations across ESM and CommonJS.');
