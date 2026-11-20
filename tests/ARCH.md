# Behavioral tests

Tests use the official TypeScript client, real Fetch requests, Express and the RPC dispatcher. They exercise failed validation, transport-specific response types, byte budgets, client cancellation, host and origin checks, generator cleanup and header isolation. Cross-runtime subprocess tests live in the matrix driver because source imports cannot establish that a published tarball is usable.

`make test` runs the suite with `bun test`. `make coverage` runs the same files with Vitest on Node and V8 coverage, which also counts branches. Bun's runner accepts the Vitest imports, so one suite covers both supported runtimes without a second copy.

Call hook tests use the SDK over Fetch to verify per-call event pairing, cancellation, decoded argument and result transformations, preserved validation and diagnostic failure isolation. The packed consumer exercises separate stdio children.

The compiler test uses real files and a TypeScript program. It checks deterministic generation, recursive type diagnostics, stale output detection, atomic preservation of prior good output and the source-extension import of a type-stripping project.

The client gate test checks that the contract in scripts/clients.ts accepts exactly the 112 documented cells and reports missing, repeated and foreign ones. The release test builds a real Git repository and checks that secrets, dependencies and stale evidence stay out of the archive selection.

VERIFIED: The Go fixture opens independent SDK sessions. Socket tests cover disconnects during dispatch and failures after headers have been written. Codec tests check the total byte budget across sibling fields and distinguish ordinary application keys from codec metadata.
