/** VERIFIED: (tests/http-boundaries.test.ts) Every HTTP adapter answers an oversized body with this JSON-RPC error. Its text matches the SDK's Node adapter, so the reply names the limit whichever layer rejects. */
export function bodyTooLarge(limit: number) {
  return {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: `Payload Too Large: Request body must not exceed ${limit} bytes` },
  } as const;
}
