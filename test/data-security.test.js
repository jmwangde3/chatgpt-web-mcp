import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyDataPaths } from '../src/shared/data-security.js';

const posix = { skip: !['linux', 'darwin'].includes(process.platform) };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-data-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('POSIX new MCP data directories are private and existing unsafe modes are preserved', posix, async t => {
  const directory = await fixture(t);
  const config = { profile: path.join(directory, 'profile'), runtimeState: path.join(directory, 'state', 'runtime.json') };
  await verifyDataPaths(config);
  for (const item of [config.profile, path.dirname(config.runtimeState)]) assert.equal((await fs.stat(item)).mode & 0o777, 0o700);
  await fs.writeFile(config.runtimeState, 'private', { mode: 0o600 });
  await verifyDataPaths(config);
  await fs.chmod(config.runtimeState, 0o644);
  await assert.rejects(verifyDataPaths(config), { code: 'PROFILE_ACL_UNSAFE' });
  assert.equal(await fs.readFile(config.runtimeState, 'utf8'), 'private');
  assert.equal((await fs.stat(config.runtimeState)).mode & 0o777, 0o644);
});
test('POSIX unsafe ancestors and state links cannot replace the protected data', posix, async t => {
  const directory = await fixture(t);
  const parent = path.join(directory, 'shared');
  await fs.mkdir(parent, { mode: 0o700 });
  await fs.chmod(parent, 0o777);
  await assert.rejects(verifyDataPaths({ dataDirectories: [path.join(parent, 'data')] }), { code: 'PROFILE_ACL_UNSAFE' });
  await fs.chmod(parent, 0o700);
  const target = path.join(directory, 'target');
  await fs.writeFile(target, 'preserve', { mode: 0o600 });
  const link = path.join(parent, 'state.json');
  await fs.symlink(target, link);
  await assert.rejects(verifyDataPaths({ runtimeState: link }), { code: 'PROFILE_ACL_UNSAFE' });
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve');
});
