# Build-time contracts

The command reads a TypeScript program and emits an importable module. It resolves exported function signatures through the type checker so aliases and imported interfaces use their actual declarations. Unsupported signatures produce diagnostics before the output file is replaced. The server and client use only the emitted data at runtime.

The emitted import names the source module as the project resolves it. A project that compiles to JavaScript needs the `.js` specifier. A project run by Bun or Node's type stripping sets `allowImportingTsExtensions` or `rewriteRelativeImportExtensions` and needs the `.ts` specifier, so the generator keeps the source extension under either option.

VERIFIED: contracts.mjs owns command exit codes. generate.mjs accepts an argument list so filesystem tests can execute the same compiler and measure its branches.
