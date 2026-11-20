/** VERIFIED: Observers see dispatch metadata. Only application processors receive decoded values. */
import type { ToolContext } from './index.js';

interface CallIdentity {
  readonly id: number;
  readonly tool: string;
  readonly transport: 'http' | 'stdio';
}
/** Metadata-only event correlated by a registry-local ID. Duration covers dispatch after the start observer returns. */
export type CallEvent = CallIdentity &
  (
    | { readonly phase: 'start' }
    | { readonly phase: 'finish'; readonly status: 'ok' | 'error' | 'cancelled'; readonly durationMs: number }
  );
type MaybePromise<T> = T | PromiseLike<T>;
/** Awaited metadata sink. A slow sink adds call latency. */
export type CallObserver = (event: CallEvent) => MaybePromise<void>;
/** Fallback for observer failures. Failure of this fallback leaves dispatch unaffected. */
export type ObserverErrorHandler = (error: unknown, event: CallEvent) => MaybePromise<void>;

/** Trusted processor context. The request can contain sensitive headers. */
export interface ProcessingCall {
  /** Registered MCP tool name. */
  readonly tool: string;
  /** Dispatch kind, which determines the native input shape. */
  readonly kind: 'function' | 'json' | 'dson' | 'binary';
  /** Per-call request, cancellation signal and progress sender. */
  readonly context: ToolContext;
}
/** Return undefined to preserve the value or an object containing its replacement. */
export type CallProcessor = (call: ProcessingCall, value: unknown) => MaybePromise<void | { value: unknown }>;
/** Install one or both transformations on a registry before opening a transport. */
export interface CallProcessors {
  /** Runs on the decoded input. JSON schema validation follows any replacement. */
  before?: CallProcessor;
  /** Runs on a successful handler result, before encoding. */
  after?: CallProcessor;
}

export async function processValue(hook: CallProcessor, call: ProcessingCall, value: unknown) {
  const replacement = await hook(call, value);
  call.context.signal.throwIfAborted();
  return replacement === undefined ? value : replacement.value;
}

/** One sequence per registry. A failed diagnostic sink cannot change the tool result. */
export function observeCalls(listener: CallObserver, onError?: ObserverErrorHandler) {
  let sequence = 0;
  async function emit(event: CallEvent) {
    try {
      await listener(event);
    } catch (error) {
      try {
        await onError?.(error, event);
      } catch {
        // The application owns the diagnostic sink and its fallback.
      }
    }
  }
  return async <R extends { isError?: unknown }>(
    tool: string,
    transport: CallIdentity['transport'],
    signal: AbortSignal,
    run: () => Promise<R>,
  ) => {
    const identity = { id: ++sequence, tool, transport };
    await emit({ ...identity, phase: 'start' });
    const start = performance.now();
    let status: 'ok' | 'error' = 'error';
    try {
      signal.throwIfAborted();
      const result = await run();
      status = result.isError ? 'error' : 'ok';
      return result;
    } finally {
      await emit({
        ...identity,
        phase: 'finish',
        status: signal.aborted ? 'cancelled' : status,
        durationMs: performance.now() - start,
      });
    }
  };
}
