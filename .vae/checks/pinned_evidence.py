"""Fail when e2e or benchmark evidence ran on another toolchain than mise.toml pins (stdlib only)."""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
pins = dict(re.findall(r'^(\w+)\s*=\s*"([^"]+)"', (root / "mise.toml").read_text(), re.M))
problems = []
for name in ("e2e.json", "bench.json", "soak.json", "large.json"):
    path = root / "output" / name
    if not path.exists():
        continue
    env = json.loads(path.read_text())["environment"]
    seen = {"node": str(env.get("node", "")).lstrip("v"), "bun": str(env.get("bun", ""))}
    if "go" in env:
        match = re.search(r"go(\d[\d.]*)", str(env["go"]))
        seen["go"] = match.group(1) if match else str(env["go"])
    for tool, version in seen.items():
        if tool in pins and version != pins[tool]:
            problems.append(f"output/{name} ran {tool} {version}, mise.toml pins {pins[tool]}")
if problems:
    print("\n".join(problems) + "\nRerun make e2e and make bench through the Makefile, which puts the mise pins first.")
    sys.exit(1)
