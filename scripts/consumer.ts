/** VERIFIED: The clean consumer resolves the public types through the installed package exports. */
import express from 'express';
import { createMcpApi, encodeBytes, decodeBytes, encodeDson, decodeDson } from 'defuss-mcp';
import { ajvValidator } from 'defuss-mcp/validation';
import { createMcpHttp } from 'defuss-mcp/http';
import { exposeRpc } from 'defuss-mcp/rpc';
import { serveMcpStdio } from 'defuss-mcp/stdio';
import { rpcRoute } from 'defuss-rpc/server';
interface Graph {
  since: Date;
  values: Set<bigint>;
}
import { getMcpClient } from 'defuss-mcp/client';
import type { Client } from '@modelcontextprotocol/client';
const identity = { name: 'consumer', version: '1' };
const migrated = createMcpApi(identity, {
  compile: ajvValidator(),
  onError(error: unknown) {
    void error;
  },
});
migrated.json('migrated', { type: 'object' }, () => 0, { validate: true });
const reserved = createMcpApi(identity, { compile: async (n: number) => n }, {});
function sum(a: number, b = 0, ...rest: number[]) {
  return a + b + rest.reduce((total, x) => total + x, 0);
}
async function echo(value: Graph) {
  return value;
}
export const tools = createMcpApi(identity, { sum, echo, state: 3 }, { compile: ajvValidator() });
export const tuple = createMcpApi(identity, [sum, echo]);
export async function checkTypes(sdk: Client) {
  const objectClient = await getMcpClient<typeof tools>(sdk);
  const arrayClient = await getMcpClient<typeof tuple>(sdk);
  const reservedClient = await getMcpClient<typeof reserved>(sdk);
  const reservedResult: number = await reservedClient.tools.compile(5);
  void reservedResult;
  const n: number = await objectClient.tools.sum(1);
  const m: number = await arrayClient.tools[0](1, 2, 3);
  const g: Graph = await arrayClient.tools[1]({ since: new Date(), values: new Set([1n]) });
  // @ts-expect-error first positional parameter is required
  await objectClient.tools.sum();
  // @ts-expect-error rich graph type survives the package declarations
  await arrayClient.tools[1]('incorrect');
  // @ts-expect-error only registered object functions can be invoked
  objectClient.tools.state();
  // @ts-expect-error tuple indices are checked
  arrayClient.tools[2]();
  return { n, m, g };
}
// @ts-expect-error tuple registration accepts functions only
createMcpApi(identity, [sum, 1]);
tools.dson<Graph>('sample', (value) => value.values);
tools.json<{ id: number }>('lookup', { type: 'object' }, (input) => input.id);
await exposeRpc(tools, rpcRoute);
express().all('/mcp', createMcpHttp(tools).middleware);
const back: Graph = decodeDson<Graph>(encodeDson({ since: new Date(), values: new Set([3n]) }));
void back;
void serveMcpStdio;
import { bunway } from 'bunway';
bunway().all('/mcp', createMcpHttp(tools).middleware);

export const counter = createMcpApi(identity, {
  count: 0,
  increment() {
    return ++this.count;
  },
});
export const bind = (sdk: Client) => getMcpClient<typeof counter>(sdk);

tools.binary('echoBytes', async (bytes, ctx) => {
  ctx.signal.throwIfAborted();
  return bytes;
});
const raw: Uint8Array = decodeBytes(encodeBytes(Buffer.from([0xff])));
void raw;

const math = createMcpApi(
  { name: 'math', version: '1' },
  {
    add(a: Uint8Array, b: Uint8Array) {
      return a.map((v, i) => v + b[i]!);
    },
  },
)
  .observeCalls((event) => {
    if (event.phase === 'finish') void event.durationMs;
  })
  .processCalls({
    before(call) {
      call.context.signal.throwIfAborted();
    },
  });
export async function addBytes(sdk: Client) {
  const { tools } = await getMcpClient<typeof math>(sdk);
  const value: Uint8Array = await tools.add(new Uint8Array([1, 2]), new Uint8Array([3, 4]));
  // @ts-expect-error the inferred argument still requires a Uint8Array
  await tools.add([1, 2], [3, 4]);
  return value;
}
