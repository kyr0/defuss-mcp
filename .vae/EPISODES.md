# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-19T15:33:25Z s=release FAIL prose,lint
2026-11-19T15:36:21Z s=release DONE fp=9a790aa55432 cov=91.2% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+31)
2026-11-19T15:36:21Z s=release FINDING src/rpc.ts / exposeRpc and ToolRegistry.group learn=test: Registration now stages discovery and checks name collisions before merging. The rollback test registers the earlier staged name again after a late duplicate.
2026-11-19T15:36:21Z s=release FINDING src/http.ts / authority and parser boundary learn=test: The tests reject a mismatched explicit port and a pre-parsed oversize Express body; concurrent era-specific requests receive their own headers.
2026-11-19T15:36:21Z s=release FINDING scripts/client.ts / stdio progress learn=test: The tested client schedules progress but clears handlers on result dispatch. The real stdio consumer asserts ordered progress frames and records callbacks separ
2026-11-19T15:36:21Z s=release FINDING scripts/matrix.ts / install and scripts/release.ts learn=verifier: The consumer compares installed build bytes; complete benchmark and end-to-end results carry packed artifact hashes, which release checks before packaging.
2026-11-19T15:36:21Z s=release FINDING tests/library.test.ts / in-flight streams learn=test: The real SDK client unblocks the running tool upon its first progress event; a separate abort test observes the cancellation signal on the server.
2026-11-19T16:56:43Z s=release DONE fp=c9ac83b8f625 cov=94.5% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+34)
2026-11-19T16:56:43Z s=release FINDING src/validation.ts / ajvValidator learn=test: The mutation regression asserts both validators' different constraints and checks that equivalent copies share one check.
2026-11-19T16:56:43Z s=release FINDING src/index.ts / createMcpApi learn=test: The runtime suite covers the options-only rename. The packed TypeScript consumer calls a method named compile with an explicit options argument.
2026-11-19T16:56:43Z s=release FINDING src/index.ts / object and tuple overloads learn=test: The packed TypeScript consumer increments this.count on a direct object and checks heterogeneous tuple indices and invalid argument types.
2026-11-19T16:56:43Z s=release FINDING src/client.ts / discovery learn=test: SDK-based tests call then, round-trip a cyclic graph and discover an empty array.
2026-11-19T16:56:43Z s=release FINDING src/http.ts / fetch learn=test: Real request tests cover an unreadable stream, malformed JSON, 415 responses, chunked oversize bodies and modern and legacy replies.
2026-11-19T16:56:43Z s=release FINDING scripts/release.ts / packed evidence learn=verifier: Release compares four evidence digests to the newly packed archive.
2026-11-19T18:51:50Z s=release DONE fp=07bb67414146 cov=94.7% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+36)
2026-11-19T18:51:50Z s=release FINDING src/binary.ts / encodeBytes and decodeBytes learn=test: Tests check every slice length from zero to 255, pooled Node buffers, canonical base64, pad bits, length bounds and round-trip equality.
2026-11-19T18:51:50Z s=release FINDING src/binary.ts / encodeTree and unpackTree learn=test: SDK round trips assert an alias, a cycle, signed zero and NaN payload bits, application keys, native Float16 where present and subview extents.
2026-11-19T18:51:50Z s=release FINDING src/node-http.ts / readBody and nodeJsonHandler learn=test: A real Node listener rejects an oversize chunked request and delivers the first chunk of a custom JSON denial before its tail is produced.
2026-11-19T18:51:50Z s=release FINDING src/validation.ts / ajvValidator learn=test: The tests exercise invalid schemas in both dialects, valid argument corrections, missing references and mutation after compilation.
2026-11-19T18:51:50Z s=release FINDING src/client.ts and src/index.ts / compact negotiation learn=test: The SDK calls the same byte-producing method with a dated argument using both wire conventions.
2026-11-19T18:51:50Z s=release FINDING scripts/compare.ts and scripts/release.ts / evidence identity learn=verifier: Release verifies the candidate and baseline digests before including the evidence.
2026-11-19T22:06:02Z s=release DONE fp=a978f06c6f0e cov=95.3% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+41)
2026-11-19T22:06:02Z s=release FINDING src/hooks.ts observeCalls; tests/library.test.ts learn=test: An async sink and its fallback both reject on every event while concurrent SDK callers still get their values. Unknown names, invalid arguments and SSE cancella
2026-11-19T22:06:02Z s=release FINDING src/index.ts json, binary and fromFunctions learn=test: Tests inject an invalid JSON property, a non-array function input, and oversized byte input and output. Invalid arguments keep the handler from running.
2026-11-19T22:06:02Z s=release FINDING src/index.ts processCalls; scripts/consumer.ts learn=test: Both forced DSON and automatic codecs run the same typed-array transform. The packed consumer separately checks inferred input and return types after both hooks
2026-11-19T22:06:02Z s=release FINDING examples/observed-stdio.ts; scripts/client.ts learn=test: Node and Bun clients parse the paired metadata from the real child stderr across the packed matrix.
2026-11-19T22:06:02Z s=release FINDING scripts/add-bench.ts; docs/VERIFICATION.md B03 learn=verifier: Every returned byte is checked after timing. File event IDs, statuses and counter totals are checked against all warmup and timed calls.
2026-11-19T22:06:02Z s=release FINDING scripts/matrix.ts install; scripts/release.ts learn=verifier: The packed verification checks installed JS against the working build. Release binds both exact-add reports to the candidate and bundled previous package.
2026-11-19T23:52:10Z s=release FAIL lint,coverage
2026-11-19T23:54:56Z s=release DONE fp=d347cf693926 cov=94.7% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+48)
2026-11-19T23:54:56Z s=release FINDING bin/contracts.mjs; tests/compiler.test.ts learn=test: Generation succeeds with an input module that throws at top level. Stale, recursive and generic inputs leave the previous file intact.
2026-11-19T23:54:56Z s=release FINDING src/contracts.ts; scripts/signature-client.mts learn=test: The clean consumer loads the registry through require and the generated binding through import, checks identity and invokes the preserved TypeScript signature u
2026-11-19T23:54:56Z s=release FINDING src/contracts.ts makeContractCodec; src/index.ts named learn=test: Tests verify zero calls on a bad byte operand, actionable field corrections, nested bytes, replacement type checks, unexpected handler output and optional/rest 
2026-11-19T23:54:56Z s=release FINDING src/rpc.ts exposeRpc; scripts/client.py learn=test: Stock Python clients compare both tool schemas, correct malformed input and call an authorized HTTP route. The same guarded bridged call is rejected through std
2026-11-19T23:54:56Z s=release FINDING README.md named contracts; docs/VERIFICATION.md B02 learn=verifier: The matrix compares a v0.4.0 positional client against the current named facade and separately exercises the original graph and positional API paths.
2026-11-19T23:54:56Z s=release FINDING scripts/matrix.ts and scripts/release.ts learn=verifier: The clean consumer compares installed files to the build. Release binds raw end-to-end and performance evidence to the candidate tarball and a checked v0.4.0 ba
2026-11-19T23:59:51Z s=release DONE fp=4952b8d10e78 cov=94.7% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+48)
2026-11-20T00:24:38Z s=release DONE fp=9e01723a968e cov=99.5% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+56)
2026-11-20T00:24:38Z s=release FINDING src/http.ts createMcpHttp legacy JSON learn=test: The regression test observes the upstream reader cancellation and the original abort reason returned to the Fetch caller.
2026-11-20T00:24:38Z s=release FINDING src/binary.ts encodeTree learn=test: The regression round-trips a byte field and a toJSON data property and still sends a callable hook through DSON.
2026-11-20T00:24:38Z s=release FINDING scripts/matrix.ts; tests/interop-go/main.go learn=test: Go verifies discovery, retry, byte values and guard behavior on all transports. Inspector CLI issues and verifies a separate stock-host call.
2026-11-20T00:24:38Z s=release FINDING scripts/api-docs.ts; src/http.ts McpHttpEndpoint learn=verifier: The release consumer reads both declaration export conditions and checks public symbols, overloads, constructors and interface fields.
2026-11-20T00:24:38Z s=release FINDING bin/generate.mjs; tests/compiler.test.ts; tests/http-boundaries.test.ts learn=test: The installed binary still runs in a clean consumer and now checks its exit status and diagnostic on invalid invocation.
2026-11-20T00:58:14Z s=12d4a3d6 FAIL prose
2026-11-20T01:10:24Z s=12d4a3d6 DONE fp=016a1eaeeea7 cov=99.5% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+64)
2026-11-20T01:10:24Z s=12d4a3d6 FINDING scripts/release.ts files() (ported from scripts/release.ts) learn=test: tests/release.test.ts builds a real Git repo with a .vae/.env.openai secret and asserts the selection excludes it
2026-11-20T01:10:24Z s=12d4a3d6 FINDING bin/generate.mjs spec rewrite learn=test: tests/compiler.test.ts asserts the .cts specifier under both options; e2e checks the published examples pair with --check
2026-11-20T01:10:24Z s=12d4a3d6 FINDING Makefile setup learn=none: only observable on a host without bun; CI installs bun before make setup
2026-11-20T01:10:24Z s=12d4a3d6 FINDING scripts/client.py progress and checked closures (B023) learn=verifier: make lint runs uv run --locked ruff check scripts
2026-11-20T01:10:24Z s=12d4a3d6 FINDING AGENTS.md:9-18 managed defuss-vae block learn=verifier: .vae/VERIFY.py CONFIG prose.allow permits the arrow in AGENTS.md only
2026-11-20T01:10:24Z s=12d4a3d6 FINDING output/binary.json, output/compare-node.json (first bench run) learn=memory: .vae/CLI_GIST.md notes that ending a turn during a detached bench lets the gate load the host
2026-11-20T01:10:24Z s=12d4a3d6 FINDING gate coverage of clients under e2e reuse learn=verifier: .vae/VERIFY.py rule clients.e2e and tests/clients.test.ts
2026-11-20T01:11:31Z s=release DONE fp=016a1eaeeea7 cov=99.5% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+64)
2026-11-20T03:47:37Z s=12d4a3d6 FAIL env.example
2026-11-20T04:11:14Z s=12d4a3d6 DONE fp=3ff47a4819b4 cov=99.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+93)
2026-11-20T04:11:14Z s=12d4a3d6 FINDING src/http.ts:readBounded learn=test: tests/http-boundaries.test.ts 'reads a Request without a body stream' and the site e2e Firefox run
2026-11-20T04:11:14Z s=12d4a3d6 FINDING src/index.ts:ToolAnnotations learn=verifier: make e2e runs api-docs.ts against the installed tarball
2026-11-20T04:11:14Z s=12d4a3d6 FINDING Makefile:PATH learn=verifier: .vae/VERIFY.py rule toolchain.pinned-evidence runs .vae/checks/pinned_evidence.py
2026-11-20T04:11:14Z s=12d4a3d6 FINDING .env.example:MCP_API_TOKEN learn=verifier: the VAE env.example check
2026-11-20T04:11:14Z s=12d4a3d6 FINDING site/src/styles.css:.mcp-diagram learn=test: site/e2e/site.test.ts 'fits a phone-width viewport without horizontal overflow' in three engines
2026-11-20T04:11:14Z s=12d4a3d6 FINDING site/build/charts.ts:barChart learn=none: rendered text size is a visual property no current test measures; screenshots after the change show equal label sizes
2026-11-20T04:11:14Z s=12d4a3d6 FINDING scripts/site-data.ts:host learn=none: display formatting of evidence strings; the site e2e asserts the page has no unfilled slot, not the format
2026-11-20T04:11:14Z s=12d4a3d6 FINDING README.md:252 L03 learn=none: wording; checked against references/PROSE.md
2026-11-20T04:11:14Z s=12d4a3d6 FINDING docs/VERIFICATION.md:3 B01 learn=none: pinned_evidence.py checks node, bun and go; uv selects its own Python
2026-11-20T04:11:14Z s=12d4a3d6 FINDING docs/VERIFICATION.md:Website A03 learn=none: wording; checked against references/PROSE.md
2026-11-20T04:12:27Z s=release DONE fp=3ff47a4819b4 cov=99.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+93)
2026-11-20T06:22:40Z s=12d4a3d6 DONE fp=8fae29e87005 cov=99.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+96)
2026-11-20T06:22:40Z s=12d4a3d6 FINDING src/node-http.ts:rejectLarge learn=test: tests/http-boundaries.test.ts writes a 4 MiB body over a raw socket before reading; it fails with ECONNRESET when connection: close is restored, and scripts/cli
2026-11-20T06:22:40Z s=12d4a3d6 FINDING src/errors.ts:bodyTooLarge learn=test: tests/http-boundaries.test.ts asserts one JSON-RPC body naming the limit for raw Node in three modes and for the Fetch declared-length and streamed paths
2026-11-20T06:22:40Z s=12d4a3d6 FINDING src/stdio.ts:LineTransport learn=test: tests/stdio.test.ts covers split and joined chunks, CRLF, invalid lines, the limit across chunks and in one chunk, close semantics and drain-aware sends
2026-11-20T06:22:40Z s=12d4a3d6 FINDING src/stdio.ts:serveMcpStdio learn=test: tests/stdio.test.ts validates maxMessageBytes; scripts/client.ts sends 8 MiB to the default stdio server and asserts the onerror line on stderr names 10485760
2026-11-20T06:22:40Z s=12d4a3d6 FINDING scripts/client.ts:soakVerdict learn=verifier: .vae/VERIFY.py rule soak.bounded via .vae/checks/soak_evidence.py; thresholds documented with their measured noise in docs/VERIFICATION.md#memory-soak
2026-11-20T06:22:40Z s=12d4a3d6 FINDING scripts/matrix.ts:Inspector download learn=none: third-party client limit documented in README; the matrix uses 11 MiB HTTP downloads that fit every client's default
2026-11-20T06:22:40Z s=12d4a3d6 FINDING scripts/client.ts:large action learn=none: driver indexing fixed; output/large.json rows now carry nonzero RSS for every server
2026-11-20T06:22:40Z s=12d4a3d6 FINDING README.md:Message size limits learn=none: documented as client behavior with versions; tests do not pin third-party defaults
2026-11-20T06:26:26Z s=release DONE fp=8fae29e87005 cov=99.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+96)
2026-11-20T14:30:55Z s=12d4a3d6 DONE fp=3186f8d00e7a cov=99.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+96)
2026-11-20T14:30:55Z s=12d4a3d6 FINDING package.json:bin learn=test: scripts/matrix.ts invokes the installed binary by its new name in every e2e run
2026-11-20T14:30:55Z s=12d4a3d6 FINDING site/index.html:#api desc learn=none: one-off wording; claim now matches the probe
2026-11-20T14:33:15Z s=release DONE fp=3186f8d00e7a cov=99.9% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+96)
