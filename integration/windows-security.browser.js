import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSecuritySnapshot, verifyWindowsPaths, windowsQuery } from '../src/shared/windows-security.js';
import { secureNewFixture } from './private-fixture.js';

const windowsOnly = { skip: process.platform !== 'win32' };

async function fixture(t) {
  const parent = path.resolve(process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp')
    : os.tmpdir());
  // Ensure the base exists without changing any existing ancestor permissions.
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'windows-security-fixture-'));
  const junctions = [];
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    // Remove junctions themselves before recursive cleanup, never their targets.
    for (const junction of junctions) {
      assert.equal(path.dirname(junction), directory);
      await fs.unlink(junction);
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    await assert.rejects(verifyWindowsPaths(input, {
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
  await assert.rejects(verifyWindowsPaths(config(source.directory, junction)), {
    code: 'PROFILE_REPARSE_POINT',
  });
  assert.equal(await fs.readFile(marker, 'utf8'), 'target must remain intact');
});

test('Windows rejects a regular file used as a profile without changing it', windowsOnly, async t => {
  const { directory } = await fixture(t);
  const input = config(directory);
  await fs.writeFile(input.profile, 'not a directory', 'utf8');
  const before = await sddl([input.profile]);
  await assert.rejects(verifyWindowsPaths(input, { allowCreate: false }), {
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
  await assert.rejects(verifyWindowsPaths(config(directory, directory), { allowCreate: false }), {
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
  await assert.rejects(verifyWindowsPaths(input, {
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
