import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bindContract, createMcp, createMcpApi, encodeBytes, type FunctionContract } from '../src/index.js';
import { createMcpHttp } from '../src/http.js';
import { getMcpClient } from '../src/client.js';
import { ajvValidator } from '../src/validation.js';

const identity = { name: 'metadata', version: '1' };
type Http = ReturnType<typeof createMcpHttp>;

async function withClient(http: Http, use: (client: Client) => Promise<void>) {
  const client = new Client(identity);
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (url, init) => http.fetch(new Request(url, init)),
    }),
  );
  try {
    await use(client);
  } finally {
    await client.close();
    await http.close();
  }
}
const pick = (tools: { name: string }[], name: string) => tools.find((tool) => tool.name === name)!;

describe('tool metadata', () => {
  it('publishes titles, descriptions and annotations for registered functions', async () => {
    const readOnly = { readOnlyHint: true, idempotentHint: true };
    const annotations = { ...readOnly };
    const api = createMcpApi(
      identity,
      {
        add(a: number, b: number) {
          return a + b;
        },
        reset() {
          return true;
        },
      },
      {
        metadata: {
          add: { title: 'Add numbers', description: 'Return a + b.', annotations },
          reset: { annotations: { destructiveHint: true } },
        },
      },
    );
    annotations.readOnlyHint = false;
    await withClient(createMcpHttp(api), async (client) => {
      const { tools } = await client.listTools();
      expect(pick(tools, 'add')).toMatchObject({
        title: 'Add numbers',
        description: 'Return a + b.',
        annotations: readOnly,
      });
      expect(pick(tools, 'reset').annotations).toEqual({ destructiveHint: true });
      const remote = await getMcpClient<typeof api>(client);
      expect(await remote.tools.add(2, 3)).toBe(5);
    });
  });

  it('names tuple entries by wire name and rejects metadata for unknown functions', () => {
    function double(n: number) {
      return n * 2;
    }
    const tuple = createMcpApi(identity, [double], { metadata: { double: { title: 'Double' } } });
    expect(tuple.factory()).toBeTypeOf('function');
    expect(() =>
      createMcpApi(identity, { double }, { metadata: { dobule: { title: 'Typo' } } } as never),
    ).toThrow(/dobule/);
  });

  it('lets registry metadata refine a generated contract', async () => {
    const contract: FunctionContract = {
      description: 'Generated summary.',
      parameters: ['n'],
      inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    };
    const square = bindContract((n: number) => n * n, contract);
    const plain = createMcpApi(identity, { square });
    const titled = createMcpApi(identity, { square }, { metadata: { square: { title: 'Square' } } });
    await withClient(createMcpHttp(plain), async (client) => {
      expect(pick((await client.listTools()).tools, 'square').description).toBe('Generated summary.');
    });
    await withClient(createMcpHttp(titled), async (client) => {
      const tool = pick((await client.listTools()).tools, 'square');
      expect(tool).toMatchObject({ title: 'Square', description: 'Generated summary.' });
      expect((await client.callTool({ name: 'square', arguments: { n: 4 } })).structuredContent).toEqual({
        value: 16,
      });
    });
  });

  it('carries metadata on JSON, DSON and binary tools', async () => {
    const tools = createMcp(identity);
    tools.json('clock', { type: 'object' }, () => 1, { title: 'Clock', annotations: { readOnlyHint: true } });
    tools.dson('graph', (value) => value, { title: 'Graph', description: 'Echo a DSON graph.' });
    tools.binary('frame', (bytes) => bytes, { title: 'Frame', annotations: { openWorldHint: false } });
    await withClient(createMcpHttp(tools), async (client) => {
      const { tools: listed } = await client.listTools();
      expect(pick(listed, 'clock')).toMatchObject({ title: 'Clock', annotations: { readOnlyHint: true } });
      expect(pick(listed, 'graph')).toMatchObject({ title: 'Graph', description: 'Echo a DSON graph.' });
      expect(pick(listed, 'frame')).toMatchObject({ title: 'Frame', annotations: { openWorldHint: false } });
      const reply = await client.callTool({ name: 'frame', arguments: encodeBytes(Uint8Array.of(9)) });
      expect(reply.structuredContent).toEqual({ bytes: 'CQ==' });
    });
  });
});

describe('JSON output schemas', () => {
  const output = { type: 'object', properties: { total: { type: 'integer' } }, required: ['total'] };
  const input = {
    type: 'object' as const,
    properties: { n: { type: 'integer' } },
    required: ['n'],
  };

  it('advertises the result shape under value and checks each result', async () => {
    const errors: string[] = [];
    const tools = createMcp(identity, {
      compile: ajvValidator(),
      onError: (error, tool) => errors.push(tool + ': ' + (error as Error).message),
    });
    tools.json<{ n: number }>('sum', input, ({ n }) => (n < 0 ? { total: 'negative' } : { total: n * 2 }), {
      outputSchema: output,
    });
    tools.json<{ n: number }>('unchecked', input, () => ({ total: 'free' }), {
      outputSchema: { type: 'object' },
      validate: false,
    });
    await withClient(createMcpHttp(tools), async (client) => {
      const { tools: listed } = await client.listTools();
      expect(pick(listed, 'sum').outputSchema).toEqual({
        type: 'object',
        properties: { value: output },
        required: ['value'],
        additionalProperties: false,
      });
      expect((await client.callTool({ name: 'sum', arguments: { n: 4 } })).structuredContent).toEqual({
        value: { total: 8 },
      });
      const broken = await client.callTool({ name: 'sum', arguments: { n: -1 } });
      expect(broken.isError).toBe(true);
      expect(broken.content).toEqual([{ type: 'text', text: 'Tool execution failed.' }]);
      expect(errors).toEqual(['sum: Handler result violates the output schema for sum']);
      expect((await client.callTool({ name: 'unchecked', arguments: { n: 1 } })).structuredContent).toEqual({
        value: { total: 'free' },
      });
    });
  });
});
