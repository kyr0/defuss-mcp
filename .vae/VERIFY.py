"""Project-local verifier policy. Agents MAY extend it; every gate executes it fail-closed."""

CONFIG = {
    "coverage_min": 60,
    "lint_command": None,          # None → `make lint` (uv run ruff check . | bunx oxlint --deny-warnings).
    "test_command": None,          # None → `make test`. Commands run in the repo root.
    "coverage_command": None,      # None → `make coverage`; output needs `TOTAL <n>%` or an `All files |…|` table.
    "integration_commands": [],    # [] → `make integration` if present.
    "e2e_commands": [],            # [] → `make e2e`: build + consume the publishable artifact.
    "e2e_paths": [],               # globs e2e depends on, e.g. ["web/*"]: e2e reruns only when one (or a build file) changed; [] → any code file.
    "timeout_s": 600,
    # `init` on a GitHub remote writes .github/workflows/verify.yml (uv/bun via their official setup actions) unless a
    # workflow already runs `make verify`, these commands or every verify verb. None → make setup, make verify.
    "ci": None,                    # None | False (no CI workflow) | ["make setup", "make ci"] (one step each)
    "layout": True,                # Makefile verbs + gitignored secrets, runtime state, dist/, caches and package folders.
    "strict": True,               # docs.pages, gitignore and package block; False makes them warnings (a project created before 0.6.0 has False).
    "gitignore_exempt": [],        # required ignore lines this project may skip, e.g. ["dist/"] for a GitHub Action that commits its build.
    "toolchain": True,             # new (sub)projects start on bun (JS/TS) / uv (Python): newly added npm/yarn/pnpm/poetry/pipenv/pdm/pip lockfiles fail.
    # Static check of every changed doc page (*.md|*.mdx|*.markdown); False disables it.
    # allow: {glob: characters a page may use as house style}, e.g. {"docs/de/*.md": "\u201e\u201c"} for German quotes.
    # phrases: extra slop regexes (any language), case-insensitive, flagged as findings.
    # html: globs of HTML pages that are prose (a project site, e.g. ["docs/*.html"]), checked in their text and
    # reader-facing attributes; other HTML files (templates, reports) are code.
    # HYPOTHESIS: most projects need no allow entry; add one only for a page whose house style needs a flagged character.
    # README.md covers the root and each package with a changed CLI|API; ARCH.md each package with changed production code
    # or deployment|schema files. A page covers the folders below it up to the next package manifest; tests, examples,
    # docs, config and data need none.
    "readme": {"exclude": []},     # folder globs exempt from README.md coverage; False drops it (the root still needs one)
    "arch": {"exclude": []},       # folder globs exempt from ARCH.md coverage; False drops it
    # Changed package.json: packageManager, description, license, author; new packages also type, linter, library build.
    "package": {"manager": "bun", "type": "module", "lint": "oxlint", "library_build": "pkgroll"},  # False disables
    # Optional for edit runs (references/EDIT.md): "guidelines" (textsorte, zielgruppe, kommunikationsziel, hausstil,
    # geschuetzte_begriffe: terms a replacement must keep) and "edit" (max_part_chars, heading_depth, attempts, the
    # budgets, tool_scope, trace, max_tokens_total); unset keys keep pro-edit's defaults.
    # AGENTS.md: the managed defuss-vae block is VAE-DIALECT, where → is the sequence|result operator; init rewrites it.
    "prose": {"allow": {"AGENTS.md": "\u2192"}, "phrases": [], "html": ["site/index.html"]},
}

# Deterministic invariants only; no semantic guesses.
# kinds: command | file_exists | contains | regex | not_regex
# When none of these can express an invariant (it needs parsing, several files, a running program or project
# semantics), plan the check like a test: write .vae/checks/<id>.py (stdlib, exits non-zero and prints what to fix)
# and add {"id": "<id>", "kind": "command", "command": "python3 .vae/checks/<id>.py", "claim": "..."}.
# scope: "path" = one exact file; "glob" = every changed code file matching (fnmatch); "glob" + "docs": True = every
# changed doc page matching, e.g. {"id": "docs.arch.diagram", "kind": "contains", "path": "docs/ARCHITECTURE.md",
# "text": "```mermaid", "claim": "architecture page keeps its diagram"}.
RULES = [{
    "id": "tests.no-mocks",
    "kind": "not_regex",
    "glob": "*",
    # Every alternative contains an escape, so this file never matches its own pattern.
    "pattern": r"unittest\.mock|from\s+unittest\s+import\s+mock|MagicMock\(|mock\.patch|mocker\.|"
               r"jest\.(?:mock|fn|spyOn)\(|vi\.(?:mock|fn|spyOn)\(|sinon\.|gomock\.|mock\.Mock\b|Mockito\.|@Mock\s|mockk\(|"
               r"@Mock(?:ito)?Bean\b|new\s+Mock<|Mock\.Of<|Substitute\.For<|A\.Fake<|mockall:{2}|#\[automock\]",
    "claim": "tests exercise real subsystems, not mock frameworks",
}, {
    # make e2e asserts the matrix while it runs; this rule also holds when the gate reuses that e2e run.
    "id": "clients.e2e",
    "kind": "command",
    "command": "bun scripts/clients.ts",
    "claim": "every supported MCP client passed every server cell against the tarball packed from this tree",
}, {
    # Human requirement: examples and tooling are TypeScript on bun; Python remains only as the Python SDK clients.
    "id": "toolchain.typescript-scripts",
    "kind": "command",
    "command": "! find examples scripts -type f -not -path '*/__pycache__/*' -not -name '*.ts' -not -name '*.mts'"
               " -not -name '*.md' -not -name '*.json' -not -name client.py -not -name add-python.py | grep .",
    "claim": "examples and scripts are TypeScript, except the two Python SDK clients",
}, {
    # A Fetch host must not load Node modules: the HTTP entry imports its Node adapter on the first middleware call.
    "id": "http.fetch-without-node",
    "kind": "not_regex",
    "path": "src/http.ts",
    "pattern": r"^import\s(?!type\b)[^;]*from\s+['\"](?:node:|@modelcontextprotocol/node|\./node-http)",
    "claim": "src/http.ts has no static import of Node modules or the Node adapter",
}, {
    # The site's figures must describe the version this tree builds.
    "id": "site.evidence-version",
    "kind": "command",
    "command": "bun -e \"const v=(f)=>JSON.parse(require('fs').readFileSync(f,'utf8')).version; if (v('package.json')!==v('site/data/evidence.json')) { console.error('Run make verify and make bench, then bun scripts/site-data.ts'); process.exit(1) }\"",
    "claim": "site/data/evidence.json comes from this package version",
}, {
    # make e2e runs the browser suite; this rule also holds when the gate reuses that e2e run.
    "id": "site.e2e",
    "kind": "command",
    "command": "bun -e \"const r=JSON.parse(require('fs').readFileSync('output/site-e2e.json','utf8')).results; const e=new Set(r.map(x=>x.engine)); if (r.length<9||!['chromium','firefox','webkit'].every(n=>e.has(n))) { console.error('Run make e2e: the site suite did not pass in all three engines'); process.exit(1) }\"",
    "claim": "the website suite passed in Chromium, Firefox and WebKit",
}, {
    # A hook shell resolved Homebrew node 26 and go 1.27.2 before the Makefile put the mise pins first.
    "id": "toolchain.pinned-evidence",
    "kind": "command",
    "command": "python3 .vae/checks/pinned_evidence.py",
    "claim": "e2e and benchmark evidence ran on the node, bun and go versions mise.toml pins",
}, {
    # A per-request leak would grow the retained heap with every round of calls.
    "id": "soak.bounded",
    "kind": "command",
    "command": "python3 .vae/checks/soak_evidence.py",
    "claim": "retained server heap stayed bounded on every HTTP stack, reply path and stdio child of the e2e tarball",
}]
