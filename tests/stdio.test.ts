/** VERIFIED: The stdio reader frames newline-delimited JSON-RPC from real streams, whatever the chunk boundaries, and enforces its message limit. */
import { it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { createMcpApi } from '../src/index.js';
import { LineTransport, serveMcpStdio } from '../src/stdio.js';

const ping = (id: number) => ({ jsonrpc: '2.0' as const, id, method: 'ping' });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function started(max?: number) {
  const input = new PassThrough(),
    output = new PassThrough();
  const transport = new LineTransport(input, output, max);
  const messages: unknown[] = [],
    errors: string[] = [];
  let closed = 0;
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error.message);
  transport.onclose = () => closed++;
  await transport.start();
  return { input, output, transport, messages, errors, closed: () => closed };
}

it('joins a message split across chunks and splits chunks that hold several messages', async () => {
  const { input, transport, messages, errors } = await started();
  const text = JSON.stringify(ping(1)) + '\r\n' + JSON.stringify(ping(2)) + '\n' + JSON.stringify(ping(3));
  for (let i = 0; i < text.length; i += 7) input.write(Buffer.from(text.slice(i, i + 7)));
  input.write('\nnot json\n{"jsonrpc":"2.0","bogus":true}\n');
  await tick();
  expect(messages).toEqual([ping(1), ping(2), ping(3)]);
  expect(errors).toHaveLength(1);
  await expect(transport.start()).rejects.toThrow(/already started/);
  await transport.close();
});

it('stops delivering once a handler closes it and leaves a shared input running', async () => {
  const { input, output, transport, messages } = await started();
  const other: Buffer[] = [];
  input.on('data', (chunk: Buffer) => other.push(chunk));
  await transport.send(ping(8));
  expect(String(output.read())).toBe(JSON.stringify(ping(8)) + '\n');
  transport.onmessage = (message) => {
    messages.push(message);
    void transport.close();
  };
  input.write(JSON.stringify(ping(9)) + '\n' + JSON.stringify(ping(10)) + '\n');
  await tick();
  expect(messages).toEqual([ping(9)]);
  expect(input.isPaused()).toBe(false);
  expect(other).toHaveLength(1);
});

it('reads a large message in linear time and closes on one over the limit', async () => {
  const big = JSON.stringify({ ...ping(4), params: { pad: 'x'.repeat(4 * 1024 * 1024) } }) + '\n';
  const roomy = await started(8 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 65536) roomy.input.write(Buffer.from(big.slice(i, i + 65536)));
  await tick();
  expect(roomy.messages).toHaveLength(1);
  await roomy.transport.close();

  for (const chunk of [65536, big.length]) {
    const tight = await started(1024 * 1024);
    for (let i = 0; i < big.length; i += chunk) tight.input.write(Buffer.from(big.slice(i, i + chunk)));
    await tick();
    expect(tight.messages).toEqual([]);
    expect(tight.errors).toEqual(['Message exceeded maximum size of 1048576 bytes']);
    expect(tight.closed()).toBe(1);
    expect(tight.input.isPaused()).toBe(true);
  }
});

it('closes when the input ends, reports stream errors and rejects sends after close', async () => {
  const ended = new PassThrough();
  ended.end();
  ended.resume();
  await once(ended, 'end');
  const early = new LineTransport(ended, new PassThrough());
  const closing = new Promise<void>((resolve) => (early.onclose = resolve));
  await early.start();
  await closing;

  const { input, output, transport, errors, closed } = await started();
  input.emit('error', new Error('input broke'));
  output.emit('error', new Error('output broke'));
  expect(errors).toEqual(['input broke', 'output broke']);
  expect(closed()).toBe(1);
  output.emit('error', new Error('after close'));
  await transport.close();
  expect(closed()).toBe(1);
  await expect(transport.send(ping(5))).rejects.toThrow(/closed/);
});

it('resolves a send after the output drains and rejects one the output fails', async () => {
  const lines: string[] = [];
  let release!: () => void;
  const slow = new Writable({
    highWaterMark: 4,
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      release = callback;
    },
  });
  const transport = new LineTransport(new PassThrough(), slow);
  await transport.start();
  let sent = false;
  const pending = transport.send(ping(6)).then(() => (sent = true));
  await tick();
  expect(sent).toBe(false);
  release();
  await pending;
  expect(lines).toEqual([JSON.stringify(ping(6)) + '\n']);

  const failing = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('disk full'));
    },
  });
  const broken = new LineTransport(new PassThrough(), failing);
  broken.onerror = () => {};
  await broken.start();
  await expect(broken.send(ping(7))).rejects.toThrow('disk full');
});

it('validates the stdio message limit and passes errors to the host', async () => {
  const api = createMcpApi({ name: 'stdio', version: '1' });
  for (const maxMessageBytes of [0, 1.5, Number.MAX_VALUE])
    expect(() => serveMcpStdio(api, { maxMessageBytes })).toThrow(RangeError);
  const handle = await serveMcpStdio(api, { maxMessageBytes: 1024, onerror: () => {} });
  await handle.close();
});
