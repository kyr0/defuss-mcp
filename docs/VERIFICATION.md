# Verification and benchmark scope

The 0.6.1 evidence comes from macOS 26.7 on an 18-core Apple M5 Max (arm64) with Node.js 24.22.3, Bun 1.4.5, Python 3.12.15 in the uv environment, Go 1.27.4, TypeScript MCP SDK 2.4.0 and Python MCP SDK 2.3.0. Releases up to 0.5.1 ran the same matrix on Linux x86-64. The CI workflow runs `make verify` on ubuntu-latest. Every HTTP cell uses defuss-rpc 2.0.0 on the same listener as defuss-mcp.

| Server | Official clients | Exchanges per client |
|---|---|---|
| Node with Express 5.3.0 | Node, Bun, Python | JSON, SSE and automatic mode, in modern and handshake eras |
| Bun with Express 5.3.0 | Node, Bun, Python | Same six HTTP cases |
| Bun with bunway 1.1.0 | Node, Bun, Python | Same six HTTP cases |
| Native Bun Fetch | Node, Bun, Python | Same six HTTP cases |
| Node or Bun child | Node, Bun, Python | Stdio discovery and calls in both eras |

The Go SDK v1.8.0 and MCP Inspector CLI v2.16.0 each add 14 cases at their default negotiation settings. Each runs against Node and Bun child processes and all three HTTP response modes on each of the four server configurations. Go compares direct and RPC schemas, checks the correction pointer for an invalid operand, retries the addition and checks RPC guard behavior. Inspector verifies the value returned by a CLI invocation. The suite has 112 end-to-end cases. Desktop hosts and interactive Inspector UI behavior are outside this matrix.

## Client gate

`scripts/clients.ts` defines the five clients, their protocol eras and the six server configurations. The matrix fails when a cell fails, is missing, repeats or falls outside that contract. The VAE gate runs the same file as the project rule `clients.e2e`. It repacks the working tree and requires `output/e2e.json` to cover all 112 cells for that exact tarball. The check therefore also holds when the gate reuses an earlier e2e run. `bun pm pack` writes identical bytes for an unchanged tree, so a different digest means the evidence tested other code.

The coverage report counts instrumented production TypeScript and the build-time contract generator. The thin executable wrapper runs in the packed suite. SDK processes, provider dependencies and test drivers are outside the V8 denominator. The packed consumer uses the TypeScript checker to inspect documentation on exported types, functions and public methods through both declaration formats. It also copies the two code blocks of the README quick start from the installed package, replaces their port with a free one, and runs the server and client with Bun. The check fails unless the client prints the greeting.

VERIFIED: The 84 TypeScript and Python combinations exercise tool discovery, a bad argument and corrected retry, real calls and response completion. Every client also exercises direct positional registration. Node and Bun call the typed facade with a cyclic graph. A packed TypeScript consumer checks object and tuple inference, optional and rest parameters, and intentionally invalid calls. The TypeScript clients also check cyclic DSON graphs, method guards, generator yields and returns, fresh class instances and a validation opt-out. The source tests verify that streaming progress arrives before a blocked tool completes and that client cancellation reaches the executing tool. The release archive includes the raw evidence under validation.

The official TypeScript 2.4.0 stdio client can skip the last progress callback when a pipe read contains both a progress frame and the terminal result. Its SDK schedules progress on a microtask and clears the callback when it dispatches the result. The TypeScript stdio tests record both decoded wire frames and delivered callbacks. Treat the tool result as the completion signal. [Client SDK source](https://github.com/modelcontextprotocol/typescript-sdk)

## Large messages

Every HTTP cell uploads 3 MiB less 4 KiB through `bytes.echo`, just under the default 4 MiB request limit once base64 and the JSON-RPC envelope enlarge it. It then downloads 11 MiB through `bytes.pattern`, which only the 16 MiB codec budget bounds. Over stdio both directions carry 6 MiB, below the TypeScript SDK's 10 MiB stdio buffer and the Go SDK's 16 MiB line. The TypeScript clients also echo a 2 MiB view through the typed facade. The TypeScript and Python clients send a 3 MiB upload, expect the JSON-RPC 413 error that names the limit, and then call another tool on the same session. The Inspector CLI downloads only, since it passes arguments on its command line. A separate stdio connection sends 8 MiB to a server with the default 10 MiB limit and expects the closed connection plus the error line that `onerror` writes to stderr.

VERIFIED: (probes before the fixes) An oversized upload to Express on Node or Bun ended the Python SDK's session with a ReadError, because the 413 reply closed the connection while httpx was still sending. Fetch and bunway servers kept the session. The 413 body was plain text on Fetch and bunway and one of two JSON-RPC messages on Express. A stdio server closed on any message over 10 MiB without a diagnostic, and `serveMcpStdio` had no option to raise that limit.

`make bench-large` times ten transfers per row with the Bun client and samples the server's resident memory every 20 ms. In one 0.6.1 run on the host above, with a load average near 8 from other work, 3 MiB uploads moved 340 to 740 MiB/s and 11 MiB downloads 320 to 640 MiB/s over HTTP, counting both directions of an echo. Over stdio, 6 MiB transfers moved 240 to 420 MiB/s. `validation/benchmarks.md` lists every row of a release. Resident memory reached 0.1 to 0.6 GiB during transfers. It includes garbage the collector has not reclaimed yet; the memory soak below measures what stays retained.

VERIFIED: On the same host, the stdio reader in `serveMcpStdio` halved the median 6 MiB stdio upload compared with the SDK's reader, from 80.6 to 40.4 ms on Node and from 56.5 to 30.4 ms on Bun. The Node server's sampled peak resident memory fell from 888 to 315 MiB.

The client limits that the README lists come from the same probes: the Python SDK's 1 MiB SSE event limit, the Go SDK's fixed 16 MiB stdio line, its closed session after a 413, and the Inspector CLI's 16 MiB SSE line followed by its one-minute timeout.

## Memory soak

`make e2e` also runs `matrix.ts soak`. A fixture server mounts the installed package on each HTTP stack and as a stdio child, and adds a tool that forces garbage collection and returns the retained heap. The Bun client sends 58,500 calls per transport in thirteen rounds, alternating a JSON tool, a typed positional call and a 1 KiB binary echo. Then it sends two batches of sixteen 1 MiB echoes. The JSON and SSE reply paths run on every HTTP stack, since automatic mode answers with one of them. The run fails when the lowest retained heap of the last third of the rounds exceeds that of the first third by more than 1 MiB on Bun or 6 MiB on Node, or when the second batch of 1 MiB echoes retains 8 MiB more than the first. Those limits come from the noise measured beforehand: Bun's retained heap varied by 0.1 MiB, and Node's old space moved between plateaus up to 3.4 MiB apart without a trend. A leak of about 47 bytes per call on Bun, or 280 on Node, reaches them. The VAE rule `soak.bounded` requires all ten runs in `output/soak.json`, each bounded, from the tarball that `output/e2e.json` tested.

## Website

The website in `site/` bundles the built `dist/` for the browser, so its demo runs the code a release ships. Its Playwright suite serves the built `docs/` folder, opens the home and not-found pages in Chromium, Firefox and WebKit, and fails on a page error or on a request outside that server. In each engine the demo lists the tools, calls one, sends an invalid argument and applies the returned correction, and calls the typed client with bytes and a Map. The suite writes `output/site-e2e.json`. The site's figures come from `site/data/evidence.json`, which `bun scripts/site-data.ts` copies from the `make verify` and `make bench` evidence of one version and tarball digest.

UNKNOWN: Deno and Cloudflare Workers are untested, and a runtime that forbids code generation from strings would reject the functions Ajv compiles for `defuss-mcp/validation`.

## Benchmarks

Each client calls the same integer addition implementation. Direct RPC uses getRpcClient. Direct MCP calls a registered JSON tool with compiled validation. Bridged MCP calls the discovered RPC method through the dispatcher. Direct registration is measured separately for JSON positional calls and the TypeScript DSON facade. Python measures the official MCP client against the same server and function. Direct RPC uses its official TypeScript client on Node and Bun.

Each scenario warms with 80 operations. Five rounds each measure 100 serial calls and twelve batches of eight concurrent calls. Rotate scenario order each round. Check every result. Timings exclude installation, process startup, negotiation and discovery. Serial p50 and p95 describe the pooled 500 calls. Throughput is the median of the five round rates. Client and server processes share one host and communicate over loopback or local pipes. Each evidence file records the host's load average, since other work on the host shifts latency. These figures describe this payload and deployment. They do not establish production capacity or a runtime ranking for different workloads.

Run make bench to regenerate the raw JSON, then make metrics to print every combination. The release includes validation/bench.json and validation/benchmarks.md. Linux evidence covers releases up to 0.5.1 and macOS evidence covers 0.5.2 to 0.6.1. Windows compatibility is unverified. Stdio and the two Streamable HTTP reply formats are covered. The historical split-endpoint HTTP plus SSE transport is outside this package's scope.

## Paired release comparison

Run `make bench-compare` for the shorter v0.4.0 versus current comparison. Both releases run under the same Node or Bun process on separate routes of one Express listener. They use the same official SDK client, credential check, schema, handler and dependency versions. Each call sends 16 or 65,536 ASCII payload bytes and returns the length. Each persistent client performs 40 warmups and eight rounds of 60 serial calls. Execution order alternates each round. Discovery and connection setup are excluded.

The separate registration experiment constructs 64 tools sharing one contract, then 64 tools with distinct constraints. Each release builds three fresh registries per round. `validation/compare-node.json` and `validation/compare-bun.json` contain both package digests, the raw times and the median within-round percentage change. `validation/comparison.md` summarizes those measurements. CPU load, JIT state and loopback scheduling affect latency, so compare the paired rounds before extrapolating.

## Binary and scalar release measurements

The binary matrix covers matched 4 KiB and 64 KiB echo calls. The TypeScript driver uses the official RPC client, ordinary base64 MCP tools, the negotiated function client and forced DSON. The Python driver compares the public byte tool with a JSON numeric list. Each client encodes, calls and decodes on every sample and checks every returned byte, including concurrent replies. Each row contains 24 serial calls and three batches of eight after warmup. The reports give useful bidirectional MiB/s, which counts the input and returned application bytes. See `validation/binary.md` and `validation/binary.json`.

The paired Express benchmark also compares both releases' default typed clients on 256 bytes through 1 MiB and a nested 64 KiB frame. Request and reply sizes are actual HTTP body lengths sampled outside the timed rounds. Eight alternating rounds check every result. The two first-registry scenarios use a fresh process for every observation and time registration after module import. The other registration scenarios reuse the process. Inspect `validation/comparison.md` and the two raw comparison files.

The scalar matrix runs against both tarballs on the same host. `validation/matrix-changes.md` lists the p50, p95 and throughput change for every shared scenario. Whole-matrix runs are sequential. These deltas include scheduling and JIT variability. The separate alternating-release experiment controls ordering within each workload.

## Two-operand byte addition

Run `make bench-add` to compare `tools.add(a, b)` with `rpc.math.add(a, b)`. Separate client and server processes share loopback. All routes use the same Express instance and the same function object. MCP uses automatic HTTP response selection and codec negotiation. The benchmark configures both HTTP body limits to 16 MiB so two 1 MiB inputs fit on the RPC route as well. Both applications use their original transport libraries.

Six warm serial workloads rotate each round. They measure the v0.4.0 positional client, the current named client with hooks off, a start/finish counter, before/after counters, two awaited JSON-line file appends, and native RPC. The file sink measures local page-cache writes without fsync. Timings include encoding, handler execution and client decoding. Byte comparison runs after the clock stops. For each operand size the JS drivers take respectively 240, 192, 72 and 24 timed samples per workload in six rounds. The two-byte input is exactly [1, 2] plus [3, 4]. Larger subviews contain every byte value and produce modular overflow. Logging checks validate the ID, transport and outcome of every pair, including warmup calls.

The Python SDK calls the same MCP endpoint in a separate pass, discovering named inputs and the output schema, correcting a malformed operand using its JSON Pointer and then passing standard base64 strings. It checks the complete output. Only TypeScript clients use the inferred method facade. See `validation/add.md` for p50 and p95 and `validation/add-node.json`, `validation/add-bun.json` for the raw timings. Serial latencies measure one in-flight call. At 2 B and 64 KiB the JS drivers also run six batches of eight concurrent additions per configuration. The batch rates include byte-for-byte verification.

The packed consumer invokes the compiler executable, compiles the generated TypeScript binding and tests nested byte input through both Node and Bun. The Python matrix repeats named discovery, correction and retry over stdio, JSON, SSE and automatic HTTP modes in both supported protocol eras. A guarded bridged method shares the direct method's schema.

VERIFIED: A disconnect test holds a legacy JSON tool call inside an RPC stream read. Aborting the HTTP request settles the pending Fetch operation with the abort reason and cancels the upstream reader. A separate codec regression test sends a byte view beside an ordinary field named toJSON and verifies both values after decoding.
