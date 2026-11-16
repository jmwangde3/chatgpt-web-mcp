import { createHash } from 'node:crypto';

export const textHash = (text = '') => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

export function matchesUserPrompt(expectedHash, plain, candidates = []) {
  if (typeof plain !== 'string' || !expectedHash) return false;
  const values = [plain, ...(Array.isArray(candidates) ? candidates.slice(0, 1) : [])];
  return values.some(value => typeof value === 'string' && textHash(value) === expectedHash);
}
