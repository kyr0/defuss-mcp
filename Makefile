NAME ?= defuss-mcp-demo
RUN  ?= exec bun examples/server.ts express 63921
N    ?= 50
export RUN
# Config: KEY=value lines of the gitignored .env reach every recipe and the app `start` runs. Make reads them, so
# `#` starts a comment and `$` must be `$$`; values needing either belong in the app's own .env loader.
-include .env
ENV_KEYS := $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env 2>/dev/null)
ifneq ($(ENV_KEYS),)
export $(ENV_KEYS)
endif
# Installer default dirs as a fallback (uv, bun, mise shims, rustup, go install, dotnet tools): shell recipes find tools
# setup just installed, while tools already on PATH keep precedence.
export PATH := $(PATH):$(HOME)/.local/bin:$(HOME)/.bun/bin:$(HOME)/.local/share/mise/shims:$(HOME)/.cargo/bin:$(HOME)/go/bin:$(HOME)/.dotnet/tools
# The mise.toml pins go first, so every recipe, including one a hook starts from a plain shell, measures the same
# toolchain. VERIFIED: a hook shell on this Mac resolved Homebrew node 26.13.1 and go 1.27.2 and wrote them into
# output/e2e.json. Without mise (CI uses its setup actions) PATH stays as above.
MISE := $(firstword $(shell command -v mise 2>/dev/null) $(wildcard $(HOME)/.local/bin/mise))
ifneq ($(MISE),)
export PATH := $(shell $(MISE) bin-paths 2>/dev/null | tr '\n' ':')$(PATH)
endif
LOG   = var/log/$(NAME)
PID   = tmp/$(NAME).pid
ALIVE = [ -f $(PID) ] && kill -0 "$$(cat $(PID))" 2>/dev/null

.PHONY: help setup start stop restart status log metrics bench test coverage lint e2e verify
.DEFAULT_GOAL := help

help: ## list the verbs with their usage (default goal)
	@awk -F':.*## ' '/^[a-zA-Z0-9_ -]+:.*## /{printf "  %-12s %s\n", $$1, $$2}' $(firstword $(MAKEFILE_LIST))

# Tools are pinned in mise.toml. Dependency installation respects both lockfiles.
# vae-setup runs last: its extractor is a bun script and mise installs the pinned bun.
setup: ## Install pinned build and test dependencies.
	@if command -v mise >/dev/null 2>&1; then mise install; fi
	bun install --frozen-lockfile
	cd site && bun install --frozen-lockfile
	cd site && if [ "$$(uname)" = Linux ]; then bunx playwright install --with-deps chromium firefox webkit; else bunx playwright install chromium firefox webkit; fi
	uv sync --locked
	cd tests/interop-go && go mod download
	$(MAKE) vae-setup


# Own process group (setsid, else job control) so stop reaps children too; redirected stdio keeps agent shells from hanging.
start: build ## run RUN detached: pid in tmp/, stdout|stderr appended to var/log/
	@mkdir -p var/log tmp
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; exit 0; fi; \
	[ -n "$$RUN" ] || { echo "Set RUN to a foreground command."; exit 6; }; \
	if command -v setsid >/dev/null 2>&1; then nohup setsid sh -c "$$RUN" >$(LOG).stdout 2>$(LOG).stderr </dev/null & \
	else set -m; nohup sh -c "$$RUN" >$(LOG).stdout 2>$(LOG).stderr </dev/null & set +m; fi; \
	echo $$! >$(PID); sleep 1; \
	if $(ALIVE); then echo "running pid=$$(cat $(PID))"; else echo "dead; see: make log"; exit 1; fi

stop: ## SIGTERM the service group, SIGKILL after 5 s
	@if $(ALIVE); then p=$$(cat $(PID)); kill -s TERM -- -$$p 2>/dev/null || kill -s TERM $$p; \
	i=0; while kill -0 $$p 2>/dev/null && [ $$i -lt 50 ]; do sleep 0.1; i=$$((i+1)); done; \
	kill -s KILL -- -$$p 2>/dev/null || true; fi; rm -f $(PID); echo stopped

restart: stop start ## stop, then start

# LSB codes (make prints them as Error N): 0 running, 1 dead with stale pid, 3 stopped.
status: ## running | dead (stale pid) | stopped, as LSB exit codes
	@if $(ALIVE); then echo "running pid=$$(cat $(PID))"; \
	elif [ -f $(PID) ]; then echo "dead pid=$$(cat $(PID)); see: make log"; exit 1; \
	else echo stopped; exit 3; fi

log: ## tail stdout and stderr logs (N=50 lines)
	@for f in $(LOG).stdout $(LOG).stderr; do [ -f $$f ] && { echo "== $$f"; tail -n $(N) $$f; }; done; \
	ls $(LOG).* >/dev/null 2>&1 || echo "∅ no logs for $(NAME)"

build: ## Build ESM, CommonJS and TypeScript declarations.
	bun run build
# The examples and scripts import the package by name, so their type check reads the built declarations.
lint: build ## Check types, lint TypeScript, Python and Go, and verify architecture coverage.
	bun run lint
	uv run --locked ruff check scripts
	cd tests/interop-go && go vet ./...
	cd site && bun run lint
	bun scripts/architecture.ts
test: ## Exercise tools, adapters, error paths and RPC guards on Bun, and the site's build renderers.
	bun run test
	cd site && bun run test
coverage: ## Rerun the suite on Node and measure source line and branch coverage.
	bun run coverage
e2e: build ## Pack, install into an empty project, run every client matrix cell, soak each transport, then the website in three browsers.
	bun scripts/matrix.ts test
	bun scripts/clients.ts
	bun scripts/matrix.ts soak
	$(MAKE) site
	cd site && bun run test:e2e
verify: lint test coverage e2e ## Run the automated verification suite.
bench: build ## Compare persistent RPC and MCP clients on matched loopback calls.
	bun scripts/matrix.ts bench --baseline
	bun scripts/matrix.ts bench
	$(MAKE) bench-binary
	$(MAKE) bench-compare
	$(MAKE) bench-add
	$(MAKE) bench-large
bench-binary: build ## Compare binary round trips with standard clients and RPC.
	bun scripts/matrix.ts binary --baseline
	bun scripts/matrix.ts binary
bench-compare: build ## Measure this release against the bundled v0.4.0 tarball on Node and Bun.
	node scripts/compare.ts
	bun scripts/compare.ts
bench-add: build ## Benchmark byte addition and optional hooks on one Express listener.
	node scripts/add-bench.ts
	bun scripts/add-bench.ts
bench-large: build ## Time megabyte uploads and downloads on every transport and sample the server's resident memory.
	bun scripts/matrix.ts large
site: build ## Build the website from site/ into docs/ with the published package build.
	cd site && bun run build
site-data: ## Copy the figures of the latest verify and bench run into site/data/evidence.json.
	bun scripts/site-data.ts
metrics: ## Summarize latency and throughput from the latest benchmark.
	bun scripts/metrics.ts output/bench.json
vae-setup: tmp/vae/plugin/scripts/vae.py ## Verify and extract the pinned VAE runtime.
tmp/vae/plugin/scripts/vae.py: vendor/defuss-vae-dc0f6b5.tar.gz
	bun scripts/vae-setup.ts
vae: vae-setup ## Run the pinned verification, review and documentation gate.
	bun scripts/gate.ts
release: verify bench vae ## Package sources, runtime builds and verification evidence locally.
	bun scripts/release.ts
.PHONY: build vae-setup vae release bench-compare bench-binary bench-add bench-large site site-data
