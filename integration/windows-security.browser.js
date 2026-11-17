import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSecuritySnapshot, verifyWindowsPaths, windowsQuery } from '../src/shared/windows-security.js';
import { secureNewFixture } from './private-fixture.js';

const windowsOnly = { skip: process.platform !== 'win32' };
const activeFixtures = new Set();

async function fixture(t) {
  if (process.platform === 'win32') assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for isolated Windows fixtures');
  const parent = path.resolve(process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Temp')
    : os.tmpdir());
  // Ensure the base exists without changing any existing ancestor permissions.
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'windows-security-fixture-'));
  activeFixtures.add(directory);
  const junctions = [];
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    // Remove junctions themselves before recursive cleanup, never their targets.
    for (const junction of junctions) {
      const relative = path.relative(directory, junction);
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      await fs.unlink(junction);
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    activeFixtures.delete(directory);
  });
  await secureNewFixture(directory);
  return { directory, junctions };
}

function config(directory, profile = path.join(directory, 'profile')) {
  return { profile, browserState: path.join(directory, 'browser-state.json') };
}

async function sddl(paths) {
  return windowsQuery(`
@{entries=@($q.paths|ForEach-Object {@{path=$_;sddl=(Get-Acl -LiteralPath $_).Sddl}})}|ConvertTo-Json -Depth 4 -Compress
`, { paths });
}

async function captureFixtures() {
  const tree = [];
  const visit = async item => {
    const stat = await fs.lstat(item);
    if (stat.isSymbolicLink()) {
      tree.push({ path: item, link: await fs.readlink(item) });
    } else if (stat.isDirectory()) {
      tree.push({ path: item, directory: true });
      for (const name of (await fs.readdir(item)).sort()) await visit(path.join(item, name));
    } else {
      tree.push({ path: item, bytes: await fs.readFile(item) });
    }
  };
  for (const root of [...activeFixtures].sort()) await visit(root);
  return { tree, acl: await sddl(tree.map(item => item.path)) };
}

async function preservingVerify(input, options) {
  const before = await captureFixtures();
  try { return await verifyWindowsPaths(input, options); }
  finally { assert.deepEqual(await captureFixtures(), before, 'rejection must preserve all fixture bytes, ACLs and tree'); }
}

async function addReadRule(item, { inheritance = 0, inheritOnly = false, independent = false } = {}) {
  const result = await windowsQuery(`
$acl=Get-Acl -LiteralPath $q.item
if($q.independent){$acl.SetAccessRuleProtection($true,$true)}
$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$propagation=[Security.AccessControl.PropagationFlags]::None
if($q.inheritOnly){$propagation=[Security.AccessControl.PropagationFlags]::InheritOnly}
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.InheritanceFlags][int]$q.inheritance,$propagation,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $q.item -AclObject $acl
@{updated=$true}|ConvertTo-Json -Compress
`, { item, inheritance, inheritOnly, independent });
  assert.equal(result.updated, true);
}

function attributedQuery(t, target, { reparse = false, recursive = false } = {}) {
  let seen = false;
  return {
    async query(script, evidence, options) {
      assert.deepEqual(evidence.initialize, []);
      const start = performance.now();
      const snapshot = await windowsQuery(script, evidence, options);
      t.diagnostic(`Real Windows query: ${Math.round(performance.now() - start)}ms; descendants=${snapshot.descendants_checked}`);
      const item = snapshot.entries.find(entry => path.resolve(entry.path).toLowerCase() === target.toLowerCase());
      assert.ok(item, 'real evidence must identify the injected unsafe item');
      if (recursive) assert.ok(snapshot.descendants_checked > 0);
      if (reparse) assert.equal(item.isReparsePoint, true);
      assert.throws(() => validateSecuritySnapshot({ ...snapshot, entries: [item], ancestors: [] }), {
        code: reparse ? 'PROFILE_REPARSE_POINT' : 'PROFILE_ACL_UNSAFE',
      });
      const safe = snapshot.entries.filter(entry => entry !== item);
      assert.ok(safe.length);
      assert.doesNotThrow(() => validateSecuritySnapshot({ ...snapshot, entries: safe }), 'other paths and host ancestors must be safe');
      seen = true;
      return snapshot;
    },
    assertSeen() { assert.equal(seen, true, 'must reach real PowerShell ACL evidence'); },
  };
}

// All mutations are confined to fresh fixtures; protected children prevent the
// synthetic parent ACE from becoming an unrelated unsafe data-directory ACE.
for (const [label, sid, mask] of [
  ['Everyone DeleteChild', 'S-1-1-0', 64],
  ['Users ChangePermissions', 'S-1-5-32-545', 262144],
  ['Users TakeOwnership', 'S-1-5-32-545', 524288],
]) {
  test(`Windows ancestor ${label} rejects without changing ACLs, bytes or tree`, windowsOnly, async t => {
    const { directory } = await fixture(t);
    const profile = path.join(directory, 'profile');
    await fs.mkdir(profile);
    await secureNewFixture(profile);
    const input = { profile, browserState: path.join(profile, 'state.json') };
    await fs.writeFile(input.browserState, 'preserve fixture state\r\n', 'utf8');
    const applied = await windowsQuery(`
try {
$acl=[IO.Directory]::GetAccessControl($q.directory,[Security.AccessControl.AccessControlSections]::Access)
$principal=New-Object Security.Principal.SecurityIdentifier($q.sid)
$rights=[Security.AccessControl.FileSystemRights][int]$q.mask
$rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,$rights,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($q.directory,$acl)
@{updated=$true}|ConvertTo-Json -Compress
} catch { @{error=$_.Exception.Message}|ConvertTo-Json -Compress }
`, { directory, sid, mask });
    assert.equal(applied.updated, true, applied.error);
    const paths = [directory, profile, input.browserState];
    const capture = async () => ({
      acl: await sddl(paths),
      bytes: await fs.readFile(input.browserState),
      tree: [await fs.readdir(directory), await fs.readdir(profile)],
    });
    const before = await capture();
    let checked = false;
    try {
    await assert.rejects(preservingVerify(input, {
      allowCreate: false,
      query: async (script, evidence) => {
        assert.deepEqual(evidence.initialize, []);
        const snapshot = await windowsQuery(script, evidence);
        const parent = snapshot.ancestors.find(entry => path.resolve(entry.path).toLowerCase() === directory.toLowerCase());
        assert.ok(parent, 'real security query must include the test parent');
        assert.ok(parent.rules.some(rule => rule.sid === sid && rule.allow && !rule.inheritOnly && (rule.mask & mask) === mask));
        // Attribution only: production verification below receives unmodified evidence.
        assert.doesNotThrow(() => validateSecuritySnapshot({ ...snapshot, ancestors: [] }), 'protected profile/state must be safe');
        assert.throws(() => validateSecuritySnapshot({ ...snapshot, ancestors: [parent] }), { code: 'PROFILE_ACL_UNSAFE' });
        for (const entry of snapshot.ancestors.filter(entry => entry !== parent)) {
          try { validateSecuritySnapshot({ ...snapshot, ancestors: [entry] }); }
          catch { t.diagnostic(`Unsafe unrelated ancestor: ${entry.path}; owner=${entry.ownerSid}`); }
        }
        assert.doesNotThrow(() => validateSecuritySnapshot({ ...snapshot, ancestors: snapshot.ancestors.filter(entry => entry !== parent) }),
          'unrelated temp ancestors are unsafe; report the host ACL instead of bypassing it');
        checked = true;
        return snapshot;
      },
    }), { code: 'PROFILE_ACL_UNSAFE' });
    assert.equal(checked, true, 'rejection must reach the real ancestor ACL evidence');
    } finally {
      assert.deepEqual(await capture(), before);
    }
  });
}

test('Windows rejects a profile junction to another test-owned temporary directory', windowsOnly, async t => {
  // Register target cleanup first so the junction root is removed first.
  const target = await fixture(t);
  const source = await fixture(t);
  const junction = path.join(source.directory, 'profile-link');
  await fs.symlink(target.directory, junction, 'junction');
  source.junctions.push(junction);
  const marker = path.join(target.directory, 'target.txt');
  await fs.writeFile(marker, 'target must remain intact', 'utf8');
  await assert.rejects(preservingVerify(config(source.directory, junction)), {
    code: 'PROFILE_REPARSE_POINT',
  });
  assert.equal(await fs.readFile(marker, 'utf8'), 'target must remain intact');
});

test('Windows rejects a regular file used as a profile without changing it', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory);
  await fs.writeFile(input.profile, 'not a directory', 'utf8');
  const before = await sddl([input.profile]);
  await assert.rejects(preservingVerify(input, { allowCreate: false }), {
    code: 'PROFILE_NOT_DIRECTORY',
  });
  assert.equal(await fs.readFile(input.profile, 'utf8'), 'not a directory');
  assert.deepEqual(await sddl([input.profile]), before);
});

test('Windows refuses an existing permissive root without repairing its ACL', windowsOnly, async t => {
  const { directory } = await fixture(t);
  // Explicitly make only this fresh fixture permissive; do not depend on host inheritance.
  const initialized = await windowsQuery(`
try {
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true,$false)
foreach($value in @($current.Value,'S-1-5-18','S-1-5-32-544','S-1-1-0')){
 $sid=New-Object Security.Principal.SecurityIdentifier($value)
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($q.directory,$acl)
@{updated=$true}|ConvertTo-Json -Compress
} catch { @{error=$_.Exception.Message}|ConvertTo-Json -Compress }
`, { directory });
  assert.equal(initialized.updated, true, initialized.error);
  const before = await sddl([directory]);
  await assert.rejects(preservingVerify(config(directory, directory), { allowCreate: false }), {
    code: 'PROFILE_ACL_UNSAFE',
  });
  assert.deepEqual(await sddl([directory]), before);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('Windows query failure preserves existing state bytes and ACLs', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory);
  await fs.mkdir(input.profile);
  const contents = Buffer.from('{"fixture":"preserve existing state"}\r\n', 'utf8');
  await fs.writeFile(input.browserState, contents);
  const paths = [directory, input.profile, input.browserState];
  const before = await sddl(paths);
  const failure = Object.assign(new Error('synthetic security query failure'), { code: 'SECURITY_QUERY_FAILED' });
  let queries = 0;
  await assert.rejects(preservingVerify(input, {
    allowCreate: false,
    query: async (_script, evidence) => {
      queries++;
      assert.deepEqual(evidence.initialize, []);
      throw failure;
    },
  }), error => error === failure);
  assert.equal(queries, 1);
  assert.deepEqual(await fs.readFile(input.browserState), contents);
  assert.deepEqual(await sddl(paths), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['browser-state.json', 'profile']);
});

test('Windows verifies a newly created profile with spaces and Chinese path characters', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory, path.join(directory, '空格 中文 profile', '新建 profile'));
  await assert.rejects(fs.stat(input.profile), { code: 'ENOENT' });
  const before = await sddl([directory]);
  const snapshot = await verifyWindowsPaths(input);
  assert.match(snapshot.currentSid, /^S-1-/);
  assert.ok((await fs.stat(input.profile)).isDirectory());
  assert.equal(snapshot.entries.length, 2);
  assert.ok(snapshot.entries.every(entry => entry.isDirectory && !entry.isReparsePoint));
  assert.deepEqual(await sddl([directory]), before);
  await verifyWindowsPaths(input, { allowCreate: false });
});

for (const [label, inheritance] of [['directory', 1], ['file', 2]]) {
  test(`Windows rejects inherit-only read for future ${label} children`, windowsOnly, async t => {
    const { directory } = await fixture(t);
    const input = config(directory);
    await fs.mkdir(input.profile);
    await addReadRule(input.profile, { inheritance, inheritOnly: true });
    const evidence = attributedQuery(t, input.profile);
    await assert.rejects(preservingVerify(input, { allowCreate: false, query: evidence.query }), { code: 'PROFILE_ACL_UNSAFE' });
    evidence.assertSeen();
  });
}

test('Windows recursive profile scan rejects a child file with an independent read ACL', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory);
  const nested = path.join(input.profile, 'nested');
  await fs.mkdir(nested, { recursive: true });
  const child = path.join(nested, 'private.dat');
  await fs.writeFile(child, 'private child bytes');
  await addReadRule(child, { independent: true });
  const evidence = attributedQuery(t, child, { recursive: true });
  await assert.rejects(preservingVerify(input, { allowCreate: false, query: evidence.query }), { code: 'PROFILE_ACL_UNSAFE' });
  evidence.assertSeen();
});

test('Windows recursive profile scan rejects an internal junction without following it', windowsOnly, async t => {
  const target = await fixture(t);
  await fs.writeFile(path.join(target.directory, 'marker'), 'target bytes');
  const source = await fixture(t);
  const input = config(source.directory);
  await fs.mkdir(input.profile);
  const junction = path.join(input.profile, 'internal-link');
  await fs.symlink(target.directory, junction, 'junction');
  source.junctions.push(junction);
  const evidence = attributedQuery(t, junction, { recursive: true, reparse: true });
  await assert.rejects(preservingVerify(input, { allowCreate: false, query: evidence.query }), { code: 'PROFILE_REPARSE_POINT' });
  evidence.assertSeen();
});

for (const [field, filename] of [
  ['taskJournal', 'tasks.json'], ['taskLock', 'tasks.json.lock'],
  ['runtimeState', 'runtime.lock'], ['operationLock', 'operation.lock'],
  ['protectedFiles', 'custom-secret.json'],
]) {
  for (const unsafeParent of [false, true]) {
    test(`Windows rejects ${filename} custom ${unsafeParent ? 'parent directory' : 'file'} ACL`, windowsOnly, async t => {
      const { directory } = await fixture(t);
      const input = config(directory);
      await fs.mkdir(input.profile);
      const custom = path.join(directory, 'custom TaskKernel location', field);
      await fs.mkdir(custom, { recursive: true });
      const file = path.join(custom, filename);
      if (field === 'protectedFiles') input.protectedFiles = [file];
      else if (field === 'runtimeState') input.runtimeState = path.join(custom, 'runtime');
      else input[field] = file;
      await fs.writeFile(file, 'preserve custom task/lock bytes');
      const target = unsafeParent ? custom : file;
      await addReadRule(target, { independent: true });
      const evidence = attributedQuery(t, target);
      await assert.rejects(preservingVerify(input, { allowCreate: false, query: evidence.query }), { code: 'PROFILE_ACL_UNSAFE' });
      evidence.assertSeen();
    });
  }
}

test('Windows scans custom dataDirectories and recursiveRoots outside the profile', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory);
  await fs.mkdir(input.profile);
  const custom = path.join(directory, 'custom recursive data');
  await fs.mkdir(custom);
  input.dataDirectories = [custom];
  input.recursiveRoots = [custom];
  const child = path.join(custom, 'private.json');
  await fs.writeFile(child, 'custom recursive bytes');
  await addReadRule(child, { independent: true });
  const evidence = attributedQuery(t, child, { recursive: true });
  await assert.rejects(preservingVerify(input, { allowCreate: false, query: evidence.query }), { code: 'PROFILE_ACL_UNSAFE' });
  evidence.assertSeen();
});

test('Windows recursive safe-profile query stays compact and reports real scan timing', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory);
  const nested = path.join(input.profile, 'nested');
  await fs.mkdir(nested, { recursive: true });
  await Promise.all(Array.from({ length: 256 }, (_, index) => fs.writeFile(path.join(nested, `safe-${index}.dat`), `fixture ${index}`)));
  const before = await captureFixtures();
  const snapshot = await verifyWindowsPaths(input, {
    allowCreate: false,
    query: async (script, evidence, options) => {
      const start = performance.now();
      const result = await windowsQuery(script, evidence, options);
      const size = Buffer.byteLength(JSON.stringify(result));
      t.diagnostic(`Real Windows safe scan: ${Math.round(performance.now() - start)}ms; descendants=${result.descendants_checked}; output=${size} bytes`);
      assert.equal(result.descendants_checked, 257);
      return result;
    },
  });
  assert.equal(snapshot.entries.length, 2, 'safe descendants must not inflate the IPC evidence');
  assert.deepEqual(await captureFixtures(), before);
});
