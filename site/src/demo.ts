// VERIFIED: (site e2e, three engines) The live demo: a defuss-mcp registry and the official MCP TypeScript client,
// both in this page. The client's transport calls endpoint.fetch directly, so
// every exchange is real Streamable HTTP without a network or a server.
import { createMcpApi, encodeDson } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';
import { getMcpClient } from 'defuss-mcp/client';
import { ajvValidator } from 'defuss-mcp/validation';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
// The binding the contract generator wrote for examples/byte-add.ts; make e2e checks it is current.
import { add as byteAdd } from '../../examples/math.mcp.ts';

function add(a: number, b: number): number {
  return a + b;
}
function tally(words: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function createApi() {
  const api = createMcpApi(
    { name: 'site-demo', version: '1.0.0' },
    { add, byteAdd, tally },
    {
      compile: ajvValidator(),
      metadata: {
        add: { title: 'Add numbers', description: 'Return a + b.', annotations: { readOnlyHint: true } },
        byteAdd: { title: 'Add byte arrays', annotations: { readOnlyHint: true, idempotentHint: true } },
        tally: { title: 'Count words', description: 'Count each word; the result is a Map.', annotations: { readOnlyHint: true } },
      },
    },
  );
  api.json<{ title: string; date: string }>(
    'schedule',
    {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1 }, date: { type: 'string', format: 'date' } },
      required: ['title', 'date'],
      additionalProperties: false,
    },
    ({ title, date }) => ({ id: 'evt-' + date.replaceAll('-', ''), title, date }),
    {
      title: 'Schedule an event',
      description: 'Store an event for an ISO date.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, date: { type: 'string', format: 'date' } },
        required: ['id', 'title', 'date'],
      },
    },
  );
  return api;
}
type Api = ReturnType<typeof createApi>;

const EXAMPLES: Record<string, unknown> = {
  add: { args: [2, 5] },
  byteAdd: { a: 'AQI=', b: 'AwQ=' },
  tally: encodeDson({ args: [['mcp', 'dson', 'mcp']] }),
  schedule: { title: 'Release review', date: '2026-12-01' },
};

const json = (value: unknown) => JSON.stringify(value, null, 2);
const $ = <T extends Element>(root: ParentNode, selector: string) => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error('demo: missing ' + selector);
  return element;
};
function show(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length}) [${[...value].join(', ')}]`;
  if (value instanceof Map)
    return `Map(${value.size}) { ${[...value].map(([k, v]) => `${JSON.stringify(k)} => ${JSON.stringify(v)}`).join(', ')} }`;
  return `${JSON.stringify(value)} : ${typeof value}`;
}

export async function initDemo(root: HTMLElement): Promise<void> {
  const status = $<HTMLElement>(root, '[data-demo-status]');
  const wire = $<HTMLTableSectionElement>(root, '[data-wire]');
  let exchange = 0;
  const encoder = new TextEncoder();
  root.dataset.state = 'starting';
  status.textContent = 'Starting the registry and the SDK client in this page…';

  const api = createApi();
  const endpoint = createMcpHttp(api);
  // Log every exchange the SDK client makes: the JSON-RPC method, status, reply type and sizes.
  async function logged(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().text() : '';
    let method = request.method;
    try {
      const message = JSON.parse(body) as { method?: string; params?: { name?: string } };
      method = (message.method ?? 'response') + (message.params?.name ? ' ' + message.params.name : '');
    } catch {
      // A GET or an empty body keeps the HTTP method as its label.
    }
    const started = performance.now();
    const response = await endpoint.fetch(request);
    const n = ++exchange;
    void response
      .clone()
      .text()
      .then((text) => {
        const row = wire.insertRow(0);
        row.className = 'table-row';
        const cells = [
          String(n),
          method,
          String(response.status),
          response.headers.get('content-type')?.split(';')[0] ?? '(none)',
          `${encoder.encode(body).byteLength}, ${encoder.encode(text).byteLength}`,
          (performance.now() - started).toFixed(2),
        ];
        cells.forEach((text, i) => {
          const cell = row.insertCell();
          cell.className = 'table-cell' + (i >= 4 ? ' mcp-num' : '');
          cell.textContent = text;
        });
      });
    return response;
  }

  const sdk = new Client({ name: 'site-demo-client', version: '1.0.0' });
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: logged }));
    const { tools } = await sdk.listTools();
    status.textContent = `Connected: the SDK client discovered ${tools.length} tools from the endpoint in this page.`;
    status.dataset.tone = 'ok';
    initCall(root, sdk, tools);
    initRepair(root, sdk);
    initTyped(root, sdk);
    root.dataset.state = 'ready';
  } catch (error) {
    status.textContent = 'The demo could not start: ' + (error as Error).message;
    status.dataset.tone = 'error';
    root.dataset.state = 'error';
  }
}

type Tools = Awaited<ReturnType<Client['listTools']>>['tools'];

function initCall(root: HTMLElement, sdk: Client, tools: Tools): void {
  const list = $<HTMLUListElement>(root, '[data-tool-list]');
  const args = $<HTMLTextAreaElement>(root, '[data-args]');
  const name = $<HTMLElement>(root, '[data-tool-name]');
  const output = $<HTMLElement>(root, '[data-call-output]');
  const meta = $<HTMLElement>(root, '[data-call-meta]');
  const schema = $<HTMLElement>(root, '[data-schema]');
  const button = $<HTMLButtonElement>(root, '[data-call]');
  let selected = tools[0]!;
  function select(tool: Tools[number]) {
    selected = tool;
    name.textContent = tool.name;
    args.value = json(EXAMPLES[tool.name] ?? {});
    schema.textContent = json(tool.inputSchema);
    for (const item of list.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.value === tool.name));
  }
  for (const tool of tools) {
    const item = document.createElement('li');
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'mcp-tool';
    choose.value = tool.name;
    const hints = Object.entries(tool.annotations ?? {})
      .filter(([, value]) => typeof value === 'boolean')
      .map(([hint, on]) => `<span class="badge" data-variant="${on ? 'outline' : 'secondary'}" data-size="sm">${hint}${on ? '' : ': false'}</span>`)
      .join('');
    choose.innerHTML = `<span class="mcp-tool-name"><code></code><span class="mcp-tool-title"></span></span><span class="mcp-tool-desc"></span><span class="mcp-tool-hints">${hints}</span>`;
    choose.querySelector('code')!.textContent = tool.name;
    choose.querySelector('.mcp-tool-title')!.textContent = tool.title ?? '';
    choose.querySelector('.mcp-tool-desc')!.textContent = tool.description ?? '';
    choose.addEventListener('click', () => select(tool));
    item.append(choose);
    list.append(item);
  }
  select(selected);
  button.disabled = false;
  button.addEventListener('click', async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args.value) as Record<string, unknown>;
    } catch {
      output.textContent = 'Arguments must be a JSON object.';
      output.dataset.tone = 'error';
      return;
    }
    button.disabled = true;
    const started = performance.now();
    try {
      const result = await sdk.callTool({ name: selected.name, arguments: parsed });
      meta.textContent = `${result.isError ? 'Tool error' : 'Result'} in ${(performance.now() - started).toFixed(2)} ms`;
      output.dataset.tone = result.isError ? 'error' : 'ok';
      output.textContent = json(result.isError ? result.structuredContent : { structuredContent: result.structuredContent });
    } catch (error) {
      output.dataset.tone = 'error';
      output.textContent = (error as Error).message;
    } finally {
      button.disabled = false;
    }
  });
}

function initRepair(root: HTMLElement, sdk: Client): void {
  const send = $<HTMLButtonElement>(root, '[data-repair-send]');
  const fix = $<HTMLButtonElement>(root, '[data-repair-fix]');
  const transcript = $<HTMLOListElement>(root, '[data-transcript]');
  let call: { a: string; b: string } = { a: 'AQI=', b: '?' };
  let issue: { path: string; keyword: string; instruction: string } | undefined;
  function say(who: 'agent' | 'server', title: string, body: unknown) {
    const item = document.createElement('li');
    item.className = 'mcp-turn';
    item.dataset.who = who;
    const head = document.createElement('p');
    head.className = 'mcp-turn-head';
    head.textContent = title;
    const pre = document.createElement('pre');
    pre.className = 'mcp-output';
    pre.textContent = typeof body === 'string' ? body : json(body);
    item.append(head, pre);
    transcript.append(item);
  }
  send.disabled = false;
  send.addEventListener('click', async () => {
    transcript.replaceChildren();
    call = { a: 'AQI=', b: '?' };
    say('agent', 'Agent sends tools/call byteAdd', call);
    const result = await sdk.callTool({ name: 'byteAdd', arguments: call });
    const content = result.structuredContent as { issues?: (typeof issue)[] };
    issue = content.issues?.[0];
    say('server', result.isError ? 'Tool error with a correction' : 'Result', result.structuredContent);
    fix.disabled = !issue;
  });
  fix.addEventListener('click', async () => {
    if (!issue) return;
    const field = issue.path.slice(1) as keyof typeof call;
    call = { ...call, [field]: 'AwQ=' };
    say('agent', `Agent reads ${issue.path} (${issue.keyword}) and resends with valid base64`, call);
    const result = await sdk.callTool({ name: 'byteAdd', arguments: call });
    const value = (result.structuredContent as { value?: string }).value;
    const bytes = value ? Uint8Array.from(atob(value), (c) => c.charCodeAt(0)) : undefined;
    say('server', result.isError ? 'Tool error' : 'Result', { ...(result.structuredContent as object), decoded: bytes && [...bytes] });
    fix.disabled = true;
    issue = undefined;
  });
}

function initTyped(root: HTMLElement, sdk: Client): void {
  const button = $<HTMLButtonElement>(root, '[data-typed]');
  const output = $<HTMLElement>(root, '[data-typed-output]');
  button.disabled = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const { tools } = await getMcpClient<Api>(sdk);
      const lines = [
        'tools.add(2, 3)          → ' + show(await tools.add(2, 3)),
        'tools.byteAdd([1,2],[3,4]) → ' + show(await tools.byteAdd(Uint8Array.of(1, 2), Uint8Array.of(3, 4))),
        "tools.tally([…])         → " + show(await tools.tally(['mcp', 'dson', 'mcp'])),
      ];
      output.dataset.tone = 'ok';
      output.textContent = lines.join('\n');
    } catch (error) {
      output.dataset.tone = 'error';
      output.textContent = (error as Error).message;
    } finally {
      button.disabled = false;
    }
  });
}
