import { describe, expect, it } from 'vitest';
import * as nodeCodec from '../src/binary.js';

type Codec = typeof nodeCodec;
type Base64Prototype = { toBase64?: unknown; setFromBase64?: unknown };

/** Load a separate codec instance while Buffer is absent, as in a browser, Deno or a Worker. */
async function withoutBuffer(): Promise<Codec> {
  const scope = globalThis as { Buffer?: unknown };
  const saved = scope.Buffer;
  delete scope.Buffer;
  try {
    return (await import('../src/binary.ts?without-buffer' as string)) as Codec;
  } finally {
    scope.Buffer = saved;
  }
}
/** Also hide the ES2026 Uint8Array base64 methods, as on Node 24 and older browsers. */
function withoutNativeBase64<T>(run: () => T): T {
  const proto = Uint8Array.prototype as Base64Prototype;
  const saved = { toBase64: proto.toBase64, setFromBase64: proto.setFromBase64 };
  delete proto.toBase64;
  delete proto.setFromBase64;
  try {
    return run();
  } finally {
    if (saved.toBase64) proto.toBase64 = saved.toBase64;
    if (saved.setFromBase64) proto.setFromBase64 = saved.setFromBase64;
  }
}

const samples = [
  ...Array.from({ length: 9 }, (_, n) => Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255)),
  Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) & 255),
  new Uint8Array(new Uint8Array([7, 8, 9, 10, 11]).buffer, 1, 3),
];

describe('codec without Node Buffer', () => {
  it('matches the Node codec byte for byte in both portable paths', async () => {
    const portable = await withoutBuffer();
    for (const run of [<T>(f: () => T) => f(), withoutNativeBase64]) {
      run(() => {
        for (const bytes of samples) {
          const encoded = portable.encodeBytes(bytes);
          expect(encoded).toEqual(nodeCodec.encodeBytes(bytes));
          const decoded = portable.decodeBytes(encoded);
          expect(decoded.byteOffset).toBe(0);
          expect([...decoded]).toEqual([...bytes]);
        }
        expect(() => portable.decodeBytes({ bytes: 'AQJ=' })).toThrow(/canonical/);
      });
    }
  });

  it('packs typed views and counts UTF-8 bytes', async () => {
    const portable = await withoutBuffer();
    const args = [new Float64Array([1.5, -2]), { frame: Uint8Array.of(1, 2, 3) }, new DataView(new ArrayBuffer(2))];
    const packed = withoutNativeBase64(() => portable.packArguments(args));
    expect(packed).toEqual(nodeCodec.packArguments(args));
    const restored = withoutNativeBase64(() => portable.unpackArguments((packed as { packed: unknown[] }).packed));
    expect(restored).toEqual(args);
    expect(portable.utf8Length('a€😀')).toBe(nodeCodec.utf8Length('a€😀'));
    expect(portable.utf8Length('a€😀')).toBe(8);
  });
});
