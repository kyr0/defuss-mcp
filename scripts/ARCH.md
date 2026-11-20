# Verification drivers

Bun runs every driver as TypeScript. The two Python files are clients of the official Python SDK, so their language is the subject of the test. Node runs client.ts, compare.ts and add-bench.ts as well, since Node is a supported runtime of the package. The drivers use node: modules only, which both runtimes provide.

The matrix creates a temporary consumer, installs the actual tarball, compares installed build bytes, checks the public types, then runs independent client and server processes. Client programs own their transport and close it after each test. The orchestrator owns the listener, the process timeout and its cleanup. Each child leads its own process group, so a timeout or an interrupted run also stops the processes that child started.

clients.ts holds the client contract: five clients, their protocol eras and the six server configurations. The matrix asserts it on every run. Run on its own, it repacks the tree and fails unless `output/e2e.json` covers every cell for that exact tarball. The VAE gate runs it as a project rule, so the check also holds when the gate reuses an earlier e2e run. `bun pm pack` writes identical bytes for an unchanged tree, which makes the digest comparison sound.

The test cells also move large messages: an upload just under the 4 MiB HTTP request limit, an 11 MiB download, which only the binary codec bounds, 6 MiB each way over stdio, and an oversized upload that must fail alone while the session keeps working. The Inspector passes arguments on its command line, so it checks only the download.

`matrix.ts soak` runs soak-server.ts, a fixture that mounts the installed package like the example server and adds a tool that forces garbage collection and returns the retained heap. The Bun client sends 58,500 small calls per transport in thirteen rounds, the first as warmup, and compares the lowest retained heap of the first and the last third. Garbage collection noise only lifts the heap above that floor, while a leak raises it. `matrix.ts large` times uploads and downloads of 1 MiB and of the largest sizes the defaults allow, and samples the server's resident memory every 20 ms with ps, which can miss a shorter peak.

The benchmark rotates methods on warmed clients and records individual serial latencies plus throughput with eight calls in flight. stats.ts supplies the one median and nearest-rank percentile that drivers and reports share. The reporting script calculates table fields from the raw evidence. Every evidence file records the host load average, since other work on the host changes latency.

The paired-release benchmark extracts both tarballs under the project so they resolve the same locked dependencies. Raw measurements separate HTTP round trips from registration. The binary workloads verify every byte. Wire-length probes run outside timed rounds. The scalar trend reruns the pinned baseline and candidate against the same client drivers. The v0.4.0 example server is plain JavaScript, which the matrix runs under the same server.ts name.

add-bench.ts mounts two packed releases and native RPC on one Express listener in a separate process. Each timed path invokes byte-add.ts with two subviews. add-python.py uses the official Python SDK on the same listener. Release evidence binds both tarball hashes.

The packed consumer runs the installed compiler, then compiles and executes the signature fixture on Node and Bun. The exact-call benchmark measures the candidate named wire path against the v0.4.0 compact positional path.

release.ts packages generated evidence beside the source in a ZIP it writes with node:zlib. release-files.ts takes the file list from Git, so `.gitignore` keeps credentials such as `.vae/.env.*`, caches and runtime state out of the archive. It adds the ignored dist, validation and vendor folders, which hold the build, the evidence and the pinned tarballs. A ZIP library would add a dependency for one archive far below the ZIP64 limits, which the writer checks. vae-setup.ts extracts the VAE runtime only after its archived bytes match the pinned digest. gate.ts and release.ts resolve VAE session folders through the runtime's own Python module, so the folder naming stays VAE's concern.

VERIFIED: The matrix builds the Go fixture once and invokes Inspector as a stock command. api-docs.ts resolves both declaration entry formats in the installed package. It fails on an undocumented public symbol or method.
