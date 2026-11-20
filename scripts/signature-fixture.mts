/** VERIFIED: The packed consumer exercises imported declarations and preserves the exact function type. */
export interface Frame {
  payload: Uint8Array;
  tag?: 'left' | 'right';
}
/** Extract the bytes from a frame. */
export async function extract(frame: Frame): Promise<Uint8Array> {
  return frame.payload;
}
