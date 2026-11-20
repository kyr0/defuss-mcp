"""VERIFIED: Time the official Python SDK calling the ordinary two-operand MCP function."""

import asyncio
import base64
import json
import math
import sys
from time import perf_counter_ns

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client


async def measure(url):
    rows = []
    async with (
        httpx2.AsyncClient(trust_env=False, timeout=60) as http,
        Client(streamable_http_client(url, http_client=http)) as sdk,
    ):
        tools = (await sdk.list_tools()).tools
        tool = next(t for t in tools if t.name == "add")
        names = tool.input_schema["required"]
        assert names == ["a", "b"] and tool.description
        assert all(
            tool.input_schema["properties"][k]["contentEncoding"] == "base64"
            for k in names
        )
        [result_name] = tool.output_schema["required"]
        assert (
            tool.output_schema["properties"][result_name]["contentEncoding"] == "base64"
        )
        request = dict(zip(names, ["AQI=", "oops%"]))
        error = await sdk.call_tool(tool.name, request)
        assert error.is_error
        [issue] = error.structured_content["issues"]
        assert issue["path"] == "/b" and "base64" in issue["instruction"]
        request[issue["path"][1:]] = "AwQ="
        corrected = await sdk.call_tool(tool.name, request)
        assert not corrected.is_error
        assert base64.b64decode(
            corrected.structured_content[result_name], validate=True
        ) == bytes([4, 6])

        async def add(a, b):
            args = {
                k: base64.b64encode(v).decode("ascii") for k, v in zip(names, (a, b))
            }
            reply = await sdk.call_tool(tool.name, args)
            assert not reply.is_error, reply
            return base64.b64decode(
                reply.structured_content[result_name], validate=True
            )

        for size, n in [(2, 120), (4096, 100), (65536, 60), (1048576, 24)]:
            a = (
                bytes((i * 37 + 11) & 255 for i in range(size))
                if size > 2
                else bytes([1, 2])
            )
            b = (
                bytes((i * 19 + 29) & 255 for i in range(size))
                if size > 2
                else bytes([3, 4])
            )
            expected = bytes((x + y) & 255 for x, y in zip(a, b))
            samples = []
            for i in range(n + 5):
                start = perf_counter_ns()
                value = await add(a, b)
                elapsed = (perf_counter_ns() - start) / 1_000_000
                assert value == expected
                if i >= 5:
                    samples.append(elapsed)
            ordered = sorted(samples)
            rows.append(
                {
                    "bytes": size,
                    "n": n,
                    "warmup": 5,
                    "ms": samples,
                    "p50": ordered[math.ceil(0.5 * n) - 1],
                    "p95": ordered[math.ceil(0.95 * n) - 1],
                }
            )
    return rows


if __name__ == "__main__":
    print(json.dumps(asyncio.run(measure(sys.argv[1]))))
