import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectProcessIdentity } from './process-identity.js';

export async function inspectLinuxBrowserProcess(expected) {
  const processInfo = await inspectProcessIdentity(expected.pid);
  if (processInfo.status === 'DEAD') return { state: 'NOT_RUNNING' };
  if (processInfo.status !== 'ALIVE') return { state: 'UNKNOWN' };
  try {
    const [command, executable, expectedExecutable] = await Promise.all([
      fs.readFile(`/proc/${expected.pid}/cmdline`, 'utf8'), fs.readlink(`/proc/${expected.pid}/exe`), fs.realpath(expected.executable),
    ]);
    const args = command.split('\0').filter(Boolean);
    const flag = name => { const matches = args.filter(a => a.startsWith(name + '=')); return matches.length === 1 ? matches[0].slice(name.length + 1) : ''; };
    if (executable !== expectedExecutable || path.resolve(flag('--user-data-dir')) !== path.resolve(expected.profile) ||
        flag('--remote-debugging-port') !== String(expected.port) || flag('--remote-debugging-address') !== '127.0.0.1' ||
        (expected.processStartIdentity && expected.processStartIdentity !== processInfo.identity)) return { state: 'IDENTITY_MISMATCH' };
    const handles = await fs.readdir(`/proc/${expected.pid}/fd`);
    const links = await Promise.all(handles.map(fd => fs.readlink(`/proc/${expected.pid}/fd/${fd}`).catch(() => '')));
    const sockets = new Set(links.map(link => /^socket:\[(\d+)\]$/.exec(link)?.[1]).filter(Boolean));
    const tcp = await fs.readFile(`/proc/${expected.pid}/net/tcp`, 'utf8');
    const listener = tcp.split('\n').slice(1).some(line => {
      const fields = line.trim().split(/\s+/);
      const [address, port] = (fields[1] || '').split(':');
      return address === '0100007F' && parseInt(port, 16) === expected.port && fields[3] === '0A' && sockets.has(fields[9]);
    });
    return { state: listener ? 'PROCESS_MATCHED' : 'PROCESS_MATCHED_NO_CDP', listener_present: listener,
      identity: { pid: expected.pid, port: expected.port, executable: expectedExecutable, profile: expected.profile, processStartIdentity: processInfo.identity } };
  } catch { return { state: 'UNKNOWN' }; }
}

export async function verifyLinuxBrowserProcess(expected) {
  const result = await inspectLinuxBrowserProcess(expected);
  if (result.state !== 'PROCESS_MATCHED') throw Object.assign(new Error('Dedicated process and listener ownership could not be verified; state was preserved.'), { code: result.state === 'PROCESS_MATCHED_NO_CDP' ? 'BROWSER_NO_CDP' : 'BROWSER_IDENTITY_MISMATCH' });
  return result.identity;
}
