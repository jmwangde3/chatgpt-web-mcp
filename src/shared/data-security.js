import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyWindowsPaths } from './windows-security.js';

// Existing permissions are verified, never repaired. New data starts private.
export async function verifyDataPaths(config, { allowCreate = true, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform === 'win32') return verifyWindowsPaths(config, { allowCreate });
  if (platform !== 'linux' && platform !== 'darwin') throw Object.assign(new Error('Data path security cannot be verified on this platform.'), { code: 'PROFILE_SECURITY_UNVERIFIED' });
  const files = [config.browserState, config.runtimeState, config.operationLock, config.taskLock, config.taskJournal,
    config.runtimeState && config.runtimeState + '.lock', ...(config.protectedFiles || [])].filter(Boolean);
  const roots = [...new Set([config.profile, ...files.map(file => path.dirname(file)), ...(config.dataDirectories || [])].filter(Boolean).map(p => path.resolve(p)))];
  const fail = () => { throw Object.assign(new Error('Data paths must be owned by this user, private, and free of links. Existing permissions were preserved.'), { code: 'PROFILE_ACL_UNSAFE' }); };
  const check = async (target, directory) => {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile())) fail();
    return stat;
  };
  for (const root of roots) {
    for (let current = root; ; current = path.dirname(current)) {
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || ((stat.mode & 0o022) && (!(stat.mode & 0o1000) || ![0, uid].includes(stat.uid)))) fail();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (path.dirname(current) === current) break;
    }
    if (allowCreate) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try { await check(root, true); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('Private data directory does not exist.'), { code: 'PROFILE_MISSING' }); throw error; }
  }
  for (const file of files) {
    try { await check(file, false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Chrome owns internal POSIX profile files (including its SingletonLock
  // symlink). Their privacy boundary is the verified 0700 profile directory.
  // MCP-owned files above must themselves be 0600.
  const stack = [...(config.recursiveRoots || [])];
  while (stack.length) {
    const directory = stack.pop();
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      await check(target, item.isDirectory());
      if (item.isDirectory()) stack.push(target);
    }
  }
}
