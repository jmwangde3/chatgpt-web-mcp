import path from 'node:path';
import { createHash } from 'node:crypto';

// Chromium's five channel-specific network sandbox capabilities. Never accept
// arbitrary AppContainer/capability SIDs or trust them as file owners.
export const networkCapabilityNames = Object.freeze([
  'lpacChromeStableNetworkSandbox', 'lpacChromeNetworkSandbox',
  'lpacChromeBetaNetworkSandbox', 'lpacChromeDevNetworkSandbox', 'lpacChromeCanaryNetworkSandbox',
]);
export const networkCapabilitySids = Object.freeze(networkCapabilityNames.map(name => {
  const digest = createHash('sha256').update(name.toUpperCase(), 'utf16le').digest();
  return 'S-1-15-3-1024-' + Array.from({ length: 8 }, (_, index) => digest.readUInt32LE(index * 4)).join('-');
}));
const canonical = value => path.win32.resolve(value).toLowerCase();
export function isNetworkResource(file, profile, excluded = []) {
  if (!file || !profile || excluded.some(item => item && (canonical(item) === canonical(file) || canonical(file).startsWith(canonical(item).replace(/\\+$/, '') + '\\')))) return false;
  const relative = path.win32.relative(canonical(profile), canonical(file));
  const parts = relative.split('\\');
  if (parts[0] !== 'default' || parts.some(part => part === '..') || path.win32.isAbsolute(relative)) return false;
  const resource = parts[1] === 'storage' && parts[2] === 'ext' && /^[a-p]{32}$/.test(parts[3] || '') && parts[4] === 'def'
    ? parts[5] : parts[1];
  return ['cache', 'network', 'shared dictionary', 'safe browsing network'].includes(resource);
}
