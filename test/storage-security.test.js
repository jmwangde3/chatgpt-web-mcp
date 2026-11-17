import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskKernel } from '../src/core/tasks.js';
import { writeState } from '../src/shared/persistent-browser.js';
import { windowsQuery } from '../src/shared/windows-security.js';

test('TaskKernel validates its actual custom journal ACL before snapshot and write side effects', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', 'journal-acl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kernel = new TaskKernel([{ id: 'chatgpt' }], { directory });
  let writes = 0;
  await kernel.locked('chatgpt', async () => { writes++; });
  const file = path.join(directory, 'chatgpt', 'tasks.json');
  await writeState(file, { version: 2, active: null, tasks: {} });
  const contents = await fs.readFile(file);
  const applied = await windowsQuery(`
$acl=Get-Acl -LiteralPath $q.file
$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'ReadData','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $q.file -AclObject $acl
@{sddl=(Get-Acl -LiteralPath $q.file).Sddl}|ConvertTo-Json -Compress
`, { file });
  await assert.rejects(kernel.list('chatgpt'), { code: 'PROFILE_ACL_UNSAFE' });
  await assert.rejects(kernel.locked('chatgpt', async () => { writes++; }), { code: 'PROFILE_ACL_UNSAFE' });
  assert.equal(writes, 1);
  assert.deepEqual(await fs.readFile(file), contents);
  const after = await windowsQuery('@{sddl=(Get-Acl -LiteralPath $q.file).Sddl}|ConvertTo-Json -Compress', { file });
  assert.equal(after.sddl, applied.sddl);
  await assert.rejects(fs.stat(file + '.lock'), { code: 'ENOENT' });
});
