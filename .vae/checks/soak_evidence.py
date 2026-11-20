"""Fail unless the soak evidence covers every transport, stayed bounded, and tested the tarball that e2e tested (stdlib only)."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
problems = []
try:
    soak = json.loads((root / "output/soak.json").read_text())
    e2e = json.loads((root / "output/e2e.json").read_text())
except (OSError, ValueError) as error:
    print(f"{error}\nRun make e2e, which writes output/soak.json.")
    sys.exit(1)
expected = {(s, p, m) for s, p in [("node", "express"), ("bun", "express"), ("bun", "bunway"), ("bun", "fetch")] for m in ("json", "sse")}
expected |= {("node", "child", "stdio"), ("bun", "child", "stdio")}
seen = {(r["server"], r["provider"], r["mode"]) for r in soak["rows"]}
problems += [f"missing soak run {' '.join(cell)}" for cell in sorted(expected - seen)]
problems += [f"soak run {r['server']} {r['provider']} {r['mode']} grew {r['growthBytes']} bytes" for r in soak["rows"] if not r["bounded"]]
if soak["environment"]["packageSha256"] != e2e["environment"]["packageSha256"]:
    problems.append("output/soak.json tested another tarball than output/e2e.json")
if problems:
    print("\n".join(problems) + "\nRerun make e2e.")
    sys.exit(1)
