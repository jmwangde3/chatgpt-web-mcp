import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectProcessIdentity } from './process-identity.js';

async function readLauncherPrefix(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// Parse a deliberately small subset; never execute or source launcher contents.
async function launcherTarget(launcher, { read, realpath }) {
  let current = await realpath(launcher);
  const visited = new Set();
  for (let depth = 0; depth < 4; depth++) {
    if (visited.has(current) || /\/(?:snap|flatpak)\//.test(current)) return null;
    visited.add(current);
    const bytes = await read(current);
    if (Buffer.isBuffer(bytes) && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) return current;
    const script = String(bytes);
    if (Buffer.byteLength(script) > 65536 || !/^#!\s*\/bin\/(?:ba)?sh(?:\s|$)/.test(script)) return null;
    const lines = script.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const redirects = new Set(['exec < /dev/null', 'exec > >(exec cat)', 'exec 2> >(exec cat >&2)']);
    const execs = lines.filter(line => /^exec\s/.test(line) && !redirects.has(line));
    if (execs.length !== 1) return null;
    const match = /^exec\s+(?:-a\s+"\$0"\s+)?(?:"(\$HERE\/[\w./-]+|\$\{HERE\}\/[\w./-]+|\/[\w./-]+)"|(\/[\w./-]+))\s+"\$@"\s*$/.exec(execs[0]);
    if (!match) return null;
    let target = match[1] || match[2];
    if (target.startsWith('$')) {
      const assignments = lines.filter(line => /\bHERE\s*=/.test(line));
      const direct = /^(?:export\s+)?HERE="\$\(dirname\s+"\$\(readlink\s+-f\s+"\$(?:0|\{0\})"\)"\)"$/;
      // Chromium's distribution wrapper binds HERE through CHROME_WRAPPER.
      const packaged = assignments[0] === 'HERE="`dirname "$CHROME_WRAPPER"`"' &&
        lines.filter(line => /\bCHROME_WRAPPER\s*=/.test(line)).length === 1 &&
        lines.includes('export CHROME_WRAPPER="`readlink -f "$0"`"');
      if (assignments.length !== 1 || (!direct.test(assignments[0]) && !packaged)) return null;
      if (lines.indexOf(assignments[0]) > lines.indexOf(execs[0])) return null;
      target = target.replace(/^\$(?:HERE|\{HERE\})/, path.posix.dirname(current));
    }
    current = await realpath(target);
  }
  return null;
}

export async function inspectLinuxBrowserProcess(expected, { read = fs.readFile, readlink = fs.readlink,
  realpath = fs.realpath, readdir = fs.readdir, inspect = inspectProcessIdentity,
  readLauncher = read === fs.readFile ? readLauncherPrefix : read } = {}) {
  const unknown = reason => ({ state: 'UNKNOWN', reason });
  const mismatch = reason => ({ state: 'IDENTITY_MISMATCH', reason });
  try {
    if (!Number.isSafeInteger(expected.pid) || expected.pid < 1 || !Number.isInteger(expected.port) ||
        expected.port < 1 || expected.port > 65535 || !path.posix.isAbsolute(expected.profile || '') ||
        !path.posix.isAbsolute(expected.executable || '')) return mismatch('INVALID_EXPECTATION');
    const processInfo = await inspect(expected.pid);
    if (processInfo.status === 'DEAD') return { state: 'NOT_RUNNING', reason: 'PROCESS_EXITED' };
    if (processInfo.status !== 'ALIVE' || !processInfo.identity) return unknown('PROCESS_IDENTITY_UNAVAILABLE');
    if (expected.processStartIdentity && expected.processStartIdentity !== processInfo.identity) return mismatch('PROCESS_START_CHANGED');
    const launcher = expected.launcherExecutable || expected.executable;
    if (!path.posix.isAbsolute(launcher)) return mismatch('INVALID_EXPECTATION');
    // Reconnect callers may replace executable with the configured launcher.
    if (expected.launcherExecutable && expected.executable !== launcher &&
        expected.executable !== expected.runtimeExecutable) return mismatch('LAUNCHER_CHANGED');
    const [command, executable, expectedExecutable] = await Promise.all([
      read(`/proc/${expected.pid}/cmdline`, 'utf8'), readlink(`/proc/${expected.pid}/exe`),
      launcherTarget(launcher, { read: readLauncher, realpath }),
    ]);
    if (!expectedExecutable) return mismatch('UNSUPPORTED_LAUNCHER');
    if (executable !== expectedExecutable || (expected.runtimeExecutable && executable !== expected.runtimeExecutable)) return mismatch('EXECUTABLE_MISMATCH');
    const args = command.split('\0').filter(Boolean);
    const flag = name => { const matches = args.filter(a => a.startsWith(name + '=')); return matches.length === 1 ? matches[0].slice(name.length + 1) : ''; };
    if (!flag('--user-data-dir') || path.posix.resolve(flag('--user-data-dir')) !== path.posix.resolve(expected.profile) ||
        flag('--remote-debugging-port') !== String(expected.port) || flag('--remote-debugging-address') !== '127.0.0.1' ||
        (expected.processStartIdentity && expected.processStartIdentity !== processInfo.identity)) return mismatch('ARGUMENT_MISMATCH');
    const handles = await readdir(`/proc/${expected.pid}/fd`);
    if (handles.length > 4096) return unknown('FD_LIMIT_EXCEEDED');
    const links = await Promise.all(handles.map(fd => readlink(`/proc/${expected.pid}/fd/${fd}`).catch(() => '')));
    const sockets = new Set(links.map(link => /^socket:\[(\d+)\]$/.exec(link)?.[1]).filter(Boolean));
    const tcp = await read(`/proc/${expected.pid}/net/tcp`, 'utf8');
    const listener = tcp.split('\n').slice(1).some(line => {
      const fields = line.trim().split(/\s+/);
      const [address, port] = (fields[1] || '').split(':');
      return address === '0100007F' && parseInt(port, 16) === expected.port && fields[3] === '0A' && sockets.has(fields[9]);
    });
    const after = await inspect(expected.pid);
    if (after.status !== 'ALIVE' || after.identity !== processInfo.identity ||
        await readlink(`/proc/${expected.pid}/exe`) !== executable ||
        await read(`/proc/${expected.pid}/cmdline`, 'utf8') !== command) return mismatch('PROCESS_CHANGED_DURING_CHECK');
    return { state: listener ? 'PROCESS_MATCHED' : 'PROCESS_MATCHED_NO_CDP', listener_present: listener,
      reason: listener ? 'VERIFIED' : 'OWNED_LOOPBACK_LISTENER_MISSING',
      identity: { pid: expected.pid, port: expected.port, executable: expectedExecutable,
        runtimeExecutable: executable, launcherExecutable: launcher, profile: expected.profile, processStartIdentity: processInfo.identity } };
  } catch { return unknown('IDENTITY_READ_FAILED'); }
}

export async function verifyLinuxBrowserProcess(expected, dependencies) {
  const result = await inspectLinuxBrowserProcess(expected, dependencies);
  if (result.state !== 'PROCESS_MATCHED') throw Object.assign(new Error('Dedicated process and listener ownership could not be verified; state was preserved.'), { code: result.state === 'PROCESS_MATCHED_NO_CDP' ? 'BROWSER_NO_CDP' : 'BROWSER_IDENTITY_MISMATCH', safeDiagnostics: { process_identity_reason: result.reason } });
  return result.identity;
}
