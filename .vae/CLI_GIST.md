# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[pinned tools] `eval "$(mise env -s bash)"` before `make`: puts mise.toml pins (bun 1.4.5, node 24.22.3, go 1.27.4, uv 0.13.9) ahead of Homebrew bun 1.4.3 and node 26 on this Mac
- VERIFIED[bench] `vae.py swarm spawn --name bench --goal … --workdir . --targets output/ -- make bench`: about 3 min on an M5 Max; ending a turn meanwhile lets the Stop-hook gate load the host
- VERIFIED[site e2e] `cd site && bunx playwright install chromium firefox webkit` once per host (make setup runs it); Playwright 1.62.1 runs under Bun, so `bun run test:e2e` drives all three engines
