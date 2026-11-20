/** VERIFIED: The official SDK chooses a protocol era on the child pipes. The caller owns process lifetime. */
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import type { ToolRegistry } from './index.js';

/** Limits and diagnostics for a stdio child. */
export interface StdioOptions {
  /**
   * Largest inbound message in bytes, default 10 MiB as in the SDK. A larger message closes the connection, so raise it
   * for binary frames over about 7 MiB, which base64 and the JSON-RPC envelope enlarge by a third.
   */
  maxMessageBytes?: number;
  /** Receives transport errors, such as an oversized message, before the connection closes. Write them to stderr. */
  onerror?: (error: Error) => void;
}

/**
 * Newline-delimited JSON-RPC over a readable and a writable stream. It keeps the chunks of a partial message and joins
 * them once when the newline arrives. VERIFIED: (probe, SDK 2.4.0) the SDK's reader concatenates its whole buffer on
 * every chunk, so one 8 MiB message in 64 KiB chunks took 129 ms and 418 MiB of resident memory on Node, against 4 ms
 * when it arrived whole. Messages are validated with the SDK's own deserializeMessage.
 */
export class LineTransport implements Transport {
  /** Called once when the transport closes. */
  onclose?: () => void;
  /** Receives stream errors, oversized messages and lines that are JSON but not JSON-RPC. */
  onerror?: (error: Error) => void;
  /** Receives each parsed message. */
  onmessage?: (message: JSONRPCMessage) => void;
  #parts: Buffer[] = [];
  #length = 0;
  #started = false;
  #closed = false;

  /** Read messages from input and write replies to output. A message over maxMessageBytes closes the transport. */
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxMessageBytes = 10 * 1024 * 1024,
  ) {}

  /** Attach to the streams. A second call throws. */
  async start() {
    if (this.#started) throw new Error('LineTransport already started');
    this.#started = true;
    if (this.input.readableEnded || this.input.destroyed) setImmediate(this.#end);
    this.input.on('data', this.#data);
    this.input.on('error', this.#inputError);
    this.input.on('end', this.#end);
    this.input.on('close', this.#end);
    this.output.on('error', this.#outputError);
  }

  #data = (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const tail = chunk.subarray(start, end);
      const size = this.#length + tail.length;
      if (size > this.maxMessageBytes) return this.#overflow();
      const line = this.#parts.length ? Buffer.concat([...this.#parts, tail], size) : tail;
      this.#parts = [];
      this.#length = 0;
      start = end + 1;
      this.#deliver(line.toString('utf8'));
      if (this.#closed) return;
    }
    if (start === chunk.length) return;
    if (this.#length + chunk.length - start > this.maxMessageBytes) return this.#overflow();
    this.#parts.push(chunk.subarray(start));
    this.#length += chunk.length - start;
  };
  #deliver(line: string) {
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch (error) {
      // Like the SDK, skip lines that are not JSON and report JSON that is not JSON-RPC.
      if (!(error instanceof SyntaxError)) this.onerror?.(error as Error);
      return;
    }
    this.onmessage?.(message);
  }
  #overflow() {
    this.onerror?.(new Error(`Message exceeded maximum size of ${this.maxMessageBytes} bytes`));
    void this.close();
  }
  #inputError = (error: Error) => this.onerror?.(error);
  #outputError = (error: Error) => {
    if (this.#closed) return;
    this.onerror?.(error);
    void this.close();
  };
  #end = () => void this.close();

  /** Detach from the streams and drop a partial message. Later calls do nothing. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.input.off('data', this.#data);
    this.input.off('error', this.#inputError);
    this.input.off('end', this.#end);
    this.input.off('close', this.#end);
    if (this.input.listenerCount('data') === 0) this.input.pause();
    this.#parts = [];
    this.#length = 0;
    this.onclose?.();
  }

  /** Resolve once the stream accepted the line, after a drain when its buffer was full. */
  send(message: JSONRPCMessage) {
    if (this.#closed) return Promise.reject(new Error('LineTransport is closed'));
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        this.output.off('error', settle);
        this.output.off('drain', settle);
        if (error) reject(error);
        else resolve();
      };
      this.output.once('error', settle);
      if (this.output.write(serializeMessage(message))) settle();
      else this.output.once('drain', settle);
    });
  }
}

/** Start serving the catalog on process stdin/stdout. Await the returned SDK handle and call close to release the transport. Send diagnostics to stderr so stdout remains valid MCP framing. */
export function serveMcpStdio(tools: ToolRegistry, options: StdioOptions = {}) {
  const { maxMessageBytes, onerror } = options;
  if (maxMessageBytes !== undefined && (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1))
    throw new RangeError('maxMessageBytes must be a positive safe integer.');
  const transport = new LineTransport(process.stdin, process.stdout, maxMessageBytes);
  return serveStdio(tools.factory(), { transport, ...(onerror && { onerror }) });
}
