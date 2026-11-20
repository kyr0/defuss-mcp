"""VERIFIED: Official Python SDK facing the same packed server as the TypeScript client."""

import asyncio
import base64
import json
import sys
import time
from contextlib import AsyncExitStack

import httpx2
from mcp import Client, MCPError, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

MIB = 1024 * 1024
MAX_SSE_EVENT = 32 * MIB


def pattern(size):
    """The example server's bytes.pattern content: byte i is (i * 37 + 11) mod 256."""
    period = bytes((i * 37 + 11) & 255 for i in range(256))
    return period * (size // 256) + period[: size % 256]


async def large_payloads(client, stdio):
    """An upload just under the 4 MiB HTTP request limit (6 MiB over stdio) and an 11 MiB download (6 MiB)."""
    upload, download = (6 * MIB, 6 * MIB) if stdio else (3 * MIB - 4096, 11 * MIB)
    sent = pattern(upload)
    echo = await client.call_tool(
        "bytes.echo", {"bytes": base64.b64encode(sent).decode("ascii")}
    )
    assert base64.b64decode(echo.structured_content["bytes"]) == sent
    got = await client.call_tool("bytes.pattern", {"size": download})
    assert base64.b64decode(got.structured_content["value"]["bytes"]) == pattern(
        download
    )
    if stdio:
        return
    # An oversized upload fails alone; the session keeps working.
    too_big = base64.b64encode(pattern(3 * MIB)).decode("ascii")
    try:
        await client.call_tool("bytes.echo", {"bytes": too_big})
        raise AssertionError("an upload over the HTTP request limit was accepted")
    except MCPError as error:
        assert "must not exceed 4194304 bytes" in str(error), error
    assert (await client.call_tool("add", {"a": 1, "b": 2})).structured_content == {
        "value": 3
    }


async def main():
    action, target, runtime = sys.argv[1:4]
    stdio = target == "stdio"
    results = []
    modes = (
        ["stdio"]
        if stdio
        else (["json", "sse", "auto"] if action == "test" else ["json", "sse"])
    )
    if action == "binary":
        print(json.dumps(await binary_benchmark(target, runtime)))
        return
    if action == "bench":
        print(json.dumps(await benchmark(modes, target, runtime)))
        return
    for era in ["auto", "legacy"] if action == "test" else ["auto"]:
        for mode in modes:
            async with AsyncExitStack() as stack:
                if stdio:
                    transport = StdioServerParameters(
                        command=runtime, args=["server.ts", "stdio"]
                    )
                else:
                    http = await stack.enter_async_context(
                        httpx2.AsyncClient(
                            headers={"x-demo-key": "demo", "x-scope": "read"},
                            trust_env=False,
                        )
                    )
                    # The SDK caps one SSE event at 1 MiB; an 11 MiB result needs more.
                    transport = streamable_http_client(
                        target + "/mcp/" + mode,
                        http_client=http,
                        max_sse_event_size=MAX_SSE_EVENT,
                    )
                client = await stack.enter_async_context(Client(transport, mode=era))
                if action == "test":
                    tools = (await client.list_tools()).tools
                    assert any(t.name == "Arithmetic.echo" for t in tools)
                    tool = next(t for t in tools if t.name == "byteAdd")
                    bridged_tool = next(t for t in tools if t.name == "math.add")
                    assert (
                        tool.input_schema == bridged_tool.input_schema
                        and tool.output_schema == bridged_tool.output_schema
                    )
                    names = tool.input_schema["required"]
                    [output] = tool.output_schema["required"]
                    assert all(
                        tool.input_schema["properties"][key]["contentEncoding"]
                        == "base64"
                        for key in names
                    )
                    args = dict(zip(names, ["AQI=", "?"]))
                    failed = await client.call_tool(tool.name, args)
                    assert failed.is_error
                    [issue] = failed.structured_content["issues"]
                    assert issue["path"] == "/b" and "base64" in issue["instruction"]
                    args[issue["path"][1:]] = "AwQ="
                    reply = await client.call_tool(tool.name, args)
                    assert not reply.is_error and base64.b64decode(
                        reply.structured_content[output], validate=True
                    ) == bytes([4, 6])
                    via_rpc = await client.call_tool(bridged_tool.name, args)
                    if stdio:
                        assert via_rpc.is_error
                    else:
                        assert (
                            not via_rpc.is_error
                            and via_rpc.structured_content == reply.structured_content
                        )
                    bad = await client.call_tool("add", {"a": "wrong", "b": 5})
                    assert (
                        bad.is_error
                        and bad.structured_content["issues"][0]["path"] == "/a"
                    )
                    assert (
                        await client.call_tool("add", {"a": 2, "b": 5})
                    ).structured_content == {"value": 7}
                    direct = await client.call_tool("directAdd", {"args": [2, 5]})
                    assert direct.structured_content == {"value": 7}
                    raw = bytes(range(256)) * 32
                    encoded = base64.b64encode(raw).decode("ascii")
                    binary = await client.call_tool("bytes.echo", {"bytes": encoded})
                    assert (
                        base64.b64decode(
                            binary.structured_content["bytes"], validate=True
                        )
                        == raw
                    )
                    await large_payloads(client, stdio)
                    seen = []

                    async def progress(number, total, message, seen=seen):
                        seen.append(number)

                    answer = await client.call_tool(
                        "progress", {}, progress_callback=progress
                    )
                    assert answer.structured_content == {"value": "done"}
                    assert seen == ([] if mode == "json" else [1, 2]), (mode, era, seen)
                    bridged = await client.call_tool(
                        "json.Arithmetic.add", {"args": [4, 7]}
                    )
                    assert bridged.structured_content == {"value": 11}
                    results.append(
                        {
                            "client": "python",
                            "mode": mode,
                            "era": era,
                            "discovery": {
                                "tool": tool.name,
                                "parameters": names,
                                "output": output,
                                "correction": issue,
                                "correctedResult": reply.structured_content,
                                "bridge": bridged_tool.name,
                                "bridgeRejected": bool(via_rpc.is_error),
                            },
                        }
                    )
    print(json.dumps(results))


async def binary_benchmark(target, runtime):
    rows = []
    modes = ["stdio"] if target == "stdio" else ["json", "sse"]
    for mode in modes:
        async with AsyncExitStack() as stack:
            if mode == "stdio":
                transport = StdioServerParameters(
                    command=runtime, args=["server.ts", "stdio"]
                )
            else:
                http = await stack.enter_async_context(
                    httpx2.AsyncClient(headers={"x-demo-key": "demo"}, trust_env=False)
                )
                transport = streamable_http_client(
                    target + "/mcp/" + mode, http_client=http
                )
            client = await stack.enter_async_context(Client(transport))
            for size in [4096, 65536]:
                raw = bytes((i * 37 + 11) & 255 for i in range(size))
                for method in ["mcp-bytes", "mcp-json-byte-list"]:

                    async def checked(method=method, client=client, raw=raw):
                        t = time.perf_counter()
                        if method == "mcp-bytes":
                            reply = await client.call_tool(
                                "bytes.echo",
                                {"bytes": base64.b64encode(raw).decode("ascii")},
                            )
                            result = base64.b64decode(
                                reply.structured_content["bytes"], validate=True
                            )
                        else:
                            reply = await client.call_tool(
                                "directEcho", {"args": [list(raw)]}
                            )
                            result = bytes(reply.structured_content["value"])
                        elapsed = (time.perf_counter() - t) * 1000
                        assert result == raw
                        return elapsed

                    for _ in range(3):
                        await checked()
                    samples, rates = [], []
                    for _ in range(3):
                        for _ in range(8):
                            samples.append(await checked())
                        start = time.perf_counter()
                        await asyncio.gather(*(checked() for _ in range(8)))
                        rates.append(8 / (time.perf_counter() - start))
                    rows.append(
                        {
                            "client": "python",
                            "mode": mode,
                            "method": method,
                            "bytes": size,
                            "samplesMs": samples,
                            "concurrency8CallsPerSecond": rates,
                        }
                    )
    return rows


async def benchmark(modes, target, runtime):
    rows, scenarios = [], []
    async with AsyncExitStack() as stack:
        for mode in modes:
            if mode == "stdio":
                transport = StdioServerParameters(
                    command=runtime, args=["server.ts", "stdio"]
                )
            else:
                http = await stack.enter_async_context(
                    httpx2.AsyncClient(
                        headers={"x-demo-key": "demo", "x-scope": "read"},
                        trust_env=False,
                    )
                )
                transport = streamable_http_client(
                    target + "/mcp/" + mode, http_client=http
                )
            client = await stack.enter_async_context(Client(transport))
            for method, name in [
                ("mcp", "add"),
                ("mcp-functions-json", "directAdd"),
                ("mcp-rpc-bridge", "json.Arithmetic.add"),
            ]:
                row = {
                    "client": "python",
                    "mode": mode,
                    "method": method,
                    "warmup": 80,
                    "calls": 100,
                    "rounds": 5,
                    "samplesMs": [],
                    "callsPerSecond": [],
                    "concurrency8CallsPerSecond": [],
                }

                async def invoke(i, client=client, method=method, name=name):
                    args = {"a": i, "b": 1} if method == "mcp" else {"args": [i, 1]}
                    result = await client.call_tool(name, args)
                    assert result.structured_content == {"value": i + 1}

                rows.append(row)
                scenarios.append((row, invoke))
        for _, invoke in scenarios:
            for i in range(80):
                await invoke(i)
        for round_index in range(5):
            for step in range(len(scenarios)):
                row, invoke = scenarios[(round_index + step) % len(scenarios)]
                start = time.perf_counter()
                for i in range(100):
                    t = time.perf_counter()
                    await invoke(i)
                    row["samplesMs"].append((time.perf_counter() - t) * 1000)
                row["callsPerSecond"].append(100 / (time.perf_counter() - start))
                start = time.perf_counter()
                for batch in range(12):
                    await asyncio.gather(
                        *(invoke(batch * 8 + lane) for lane in range(8))
                    )
                row["concurrency8CallsPerSecond"].append(
                    96 / (time.perf_counter() - start)
                )
    return rows


if __name__ == "__main__":
    asyncio.run(main())
