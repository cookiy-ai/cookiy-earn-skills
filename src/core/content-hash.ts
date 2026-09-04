import { createHash } from 'node:crypto';

export function contentHash(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}
