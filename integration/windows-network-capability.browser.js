import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { networkCapabilityNames, networkCapabilitySids } from '../src/shared/windows-capabilities.js';
import { verifyWindowsPaths, windowsQuery } from '../src/shared/windows-security.js';
import { secureNewFixture } from './private-fixture.js';

const actualWin = { skip: process.platform !== 'win32', timeout: 60000 };
const stable = networkCapabilitySids[networkCapabilityNames.indexOf('lpacChromeStableNetworkSandbox')];
const unknown = 'S-1-15-3-1024-1-2-3-4-5-6-7-8';
const extensionId = 'nmmhkkegccagdldgiimedpiccmgmieda';

async function fixture(t) {
  assert.ok(process.env.LOCALAPPDATA);
  const parent = path.resolve(process.env.LOCALAPPDATA, 'Temp');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'network-capability-fixture-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('network-capability-fixture-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await secureNewFixture(root);
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const input = { profile, browserState: path.join(root, 'browser-state.json') };
  await fs.writeFile(input.browserState, '{"fixture":"preserve"}\r\n', 'utf8');
  const files = [];
  for (const area of ['Cache', 'Network', 'Shared Dictionary']) {
    const directory = path.join(profile, 'Default', area, 'nested');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'fixture.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 127, 255]));
    files.push(file);
  }
  return { root, input, files };
}

async function grant(item, sid, { inherit = false, owner = false } = {}) {
  const result = await windowsQuery(`
$acl=Get-Acl -LiteralPath $q.item
$principal=New-Object Security.Principal.SecurityIdentifier($q.sid)
if($q.owner){$acl.SetOwner($principal)}else{
 $flags=[Security.AccessControl.InheritanceFlags]::None
 if($q.inherit){$flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,[Security.AccessControl.FileSystemRights]::Read,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $q.item -AclObject $acl
@{updated=$true}|ConvertTo-Json -Compress
`, { item, sid, inherit, owner });
  assert.equal(result.updated, true);
}

async function capture(root) {
  const tree = [];
  async function visit(item) {
    const stat = await fs.lstat(item);
    assert.equal(stat.isSymbolicLink(), false, 'fixture never follows links');
    tree.push({ path: item, directory: stat.isDirectory(), ...(stat.isDirectory() ? {} : { bytes: await fs.readFile(item) }) });
    if (stat.isDirectory()) for (const name of (await fs.readdir(item)).sort()) await visit(path.join(item, name));
  }
  await visit(root);
  const acl = await windowsQuery(`
@{entries=@($q.paths|ForEach-Object {@{path=$_;sddl=(Get-Acl -LiteralPath $_).Sddl}})}|ConvertTo-Json -Depth 4 -Compress
`, { paths: tree.map(item => item.path) });
  return { tree, acl };
}

async function verifyPreserved(f, rejected = false) {
  const before = await capture(f.root);
  try {
    const verify = verifyWindowsPaths(f.input, { allowCreate: false });
    if (rejected) await assert.rejects(verify, { code: 'PROFILE_ACL_UNSAFE' });
    else assert.ok((await verify).descendants_checked >= 9, 'production recursive scan must visit nested network resources');
  } finally {
    assert.deepEqual(await capture(f.root), before, 'verification preserves fixture bytes, ACLs and complete tree');
  }
}

test('actualWin known network capability inherited directory/file ACEs pass production scan', actualWin, async t => {
  const f = await fixture(t);
  for (const area of ['Cache', 'Network', 'Shared Dictionary']) {
    await grant(path.join(f.input.profile, 'Default', area), stable, { inherit: true });
  }
  const evidence = await windowsQuery(`
@{entries=@($q.paths|ForEach-Object {
 $acl=Get-Acl -LiteralPath $_
 @{path=$_;inherited=@($acl.Access|Where-Object {$_.IsInherited -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $q.sid}).Count}
})}|ConvertTo-Json -Depth 4 -Compress
`, { paths: f.files, sid: stable });
  for (const entry of evidence.entries) assert.ok(entry.inherited > 0, 'real child file must inherit the capability ACE');
  await verifyPreserved(f);
});

test('actualWin exact extension def resources and Safe Browsing Network accept stable capability', actualWin, async t => {
  const f = await fixture(t);
  const directories = [path.join(f.input.profile, 'Default', 'Safe Browsing Network'),
    ...['Cache', 'Network', 'Shared Dictionary', 'Safe Browsing Network'].map(area =>
      path.join(f.input.profile, 'Default', 'Storage', 'ext', extensionId, 'def', area))];
  for (const directory of directories) {
    await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
    await fs.writeFile(path.join(directory, 'nested', 'fixture.bin'), 'preserve extension data', 'utf8');
    await grant(directory, stable, { inherit: true });
  }
  await verifyPreserved(f);
});

for (const [id, partition] of [['q'.repeat(32), 'def'], [extensionId, 'other']]) {
  test(`actualWin extension scope rejects invalid id/partition ${id}/${partition}`, actualWin, async t => {
    const f = await fixture(t);
    const directory = path.join(f.input.profile, 'Default', 'Storage', 'ext', id, partition, 'Cache');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'fixture.bin');
    await fs.writeFile(file, 'preserve invalid scope', 'utf8');
    await grant(file, stable);
    await verifyPreserved(f, true);
  });
}

for (const [label, sid] of [['mixed Everyone read', 'S-1-1-0'], ['Users read', 'S-1-5-32-545'],
  ['unknown capability', unknown], ['arbitrary AppContainer', 'S-1-15-2-1-2-3-4-5-6-7']]) {
  test(`actualWin ${label} rejects without changing bytes, ACLs or tree`, actualWin, async t => {
    const f = await fixture(t);
    await grant(path.join(f.input.profile, 'Default', 'Network'), stable, { inherit: true });
    await grant(f.files[1], sid);
    await verifyPreserved(f, true);
  });
}

for (const location of ['profile', 'Default', 'runtime', 'tasks', 'protected', 'dataDirectory', 'recursiveRoot']) {
  test(`actualWin known capability on ${location} rejects without mutation`, actualWin, async t => {
    const f = await fixture(t);
    const network = path.join(f.input.profile, 'Default', 'Network');
    let target;
    if (location === 'profile') target = f.input.profile;
    else if (location === 'Default') target = path.join(f.input.profile, 'Default');
    else if (location === 'runtime' || location === 'tasks' || location === 'protected') {
      target = path.join(network, `${location}.json`);
      await fs.writeFile(target, '{"preserve":true}', 'utf8');
      if (location === 'runtime') f.input.runtimeState = target;
      else if (location === 'tasks') f.input.taskJournal = target;
      else f.input.protectedFiles = [target];
    } else {
      const directory = path.join(network, location);
      await fs.mkdir(directory);
      target = path.join(directory, 'child.json');
      await fs.writeFile(target, 'preserve descendant', 'utf8');
      f.input[location === 'dataDirectory' ? 'dataDirectories' : 'recursiveRoots'] = [directory];
    }
    await grant(target, stable);
    await verifyPreserved(f, true);
  });
}

test('actualWin capability owner is rejected using real ACL evidence without assigning account ownership', actualWin, async t => {
  const f = await fixture(t);
  await grant(f.files[1], stable);
  const before = await capture(f.root);
  // Windows does not generally permit assigning a capability SID as owner without
  // elevated restore privileges. Preserve real fixture ACLs and alter only the
  // returned owner evidence; production validator must still reject it.
  let checked = false;
  await assert.rejects(verifyWindowsPaths(f.input, { allowCreate: false, query: async (script, input, options) => {
    const snapshot = await windowsQuery(script, input, options);
    const entry = snapshot.entries.find(item => item.path.toLowerCase() === f.input.profile.toLowerCase());
    assert.ok(entry);
    entry.ownerSid = stable;
    checked = true;
    return snapshot;
  } }), { code: 'PROFILE_ACL_UNSAFE' });
  assert.equal(checked, true);
  assert.deepEqual(await capture(f.root), before);
});

for (const [label, mask, mapped] of [['GR', -2147483648, 0x120089], ['GW', 0x40000000, 0x120116],
  ['GX', 0x20000000, 0x1200a0], ['GA', 0x10000000, 0x1f01ff]]) {
  test(`actualWin raw ${label} Everyone ACE rejects and preserves bytes ACLs tree`, actualWin, async t => {
    const f = await fixture(t);
    const file = f.files[1];
    await grant(path.dirname(file), stable, { inherit: true });
    // Insert the actual GENERIC_* bit in a raw ACE, rather than requesting the
    // already mapped FileSystemRights.Read/Write/Execute value from .NET.
    const evidence = await windowsQuery(`
$acl=Get-Acl -LiteralPath $q.file
$raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)
$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$ace=New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,[int]$q.mask,$sid,$false,$null)
$raw.DiscretionaryAcl.InsertAce(0,$ace)
$bytes=New-Object byte[] $raw.BinaryLength
$raw.GetBinaryForm($bytes,0)
$acl.SetSecurityDescriptorBinaryForm($bytes,[Security.AccessControl.AccessControlSections]::Access)
Set-Acl -LiteralPath $q.file -AclObject $acl
$persisted=Get-Acl -LiteralPath $q.file
@{masks=@($persisted.Access|Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow'}|ForEach-Object {[int64]$_.FileSystemRights})}|ConvertTo-Json -Depth 4 -Compress
`, { file, mask });
    assert.ok(evidence.masks.some(value => (value & mask) !== 0 || (value & mapped) === mapped),
      'real filesystem must retain generic rights or their Windows mapped equivalent');
    await verifyPreserved(f, true);
  });
}
