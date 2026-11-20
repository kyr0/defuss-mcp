// VERIFIED: Uint8Array.map applies modulo 256 to each result.
/**
 * Add equal-length byte arrays elementwise, modulo 256.
 * @param a First operand, in canonical padded base64 on the wire.
 * @param b Second operand, in canonical padded base64 on the wire.
 * @returns Elementwise sum as canonical padded base64.
 */
export function add(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new RangeError('Expected equal lengths.');
  return a.map((v, i) => v + b[i]!);
}
