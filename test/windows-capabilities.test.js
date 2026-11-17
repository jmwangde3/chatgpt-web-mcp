import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { networkCapabilityNames, networkCapabilitySids, isNetworkResource } from '../src/shared/windows-capabilities.js';
import { validateSecuritySnapshot, windowsQuery } from '../src/shared/windows-security.js';

// Chromium chrome/browser/chrome_content_browser_client.cc:
// GetLPACCapabilityNameForNetworkService; content/browser/network_sandbox.cc.
const names = ['lpacChromeStableNetworkSandbox', 'lpacChromeNetworkSandbox',
  'lpacChromeBetaNetworkSandbox', 'lpacChromeDevNetworkSandbox', 'lpacChromeCanaryNetworkSandbox'];
const fixedSids = [
  'S-1-15-3-1024-1653277547-598600573-1504598449-2187120098-1115546814-1860042162-2924348907-3700367812',
  'S-1-15-3-1024-1528657515-1944437972-2795272136-1227674495-293963776-353393192-4060142787-1908764039',
  'S-1-15-3-1024-3931741407-194320039-954122793-2736618539-15631989-2096576195-3738551533-2794358196',
  'S-1-15-3-1024-2897796341-2254461587-485455089-1185376275-179558876-970812073-3550259901-4038407041',
  'S-1-15-3-1024-851005249-2150182839-3187957298-1201809663-1391943268-2414741852-1623534895-2348085605',
];
const derive = name => {
  const hash = createHash('sha256').update(name.toUpperCase(), 'utf16le').digest();
  return `S-1-15-3-1024-${Array.from({ length: 8 }, (_, i) => hash.readUInt32LE(i * 4)).join('-')}`;
};
const profile = 'C:\\fixture\\profile';
const currentSid = 'S-1-5-21-111-222-333-1001';
const config = { profile };
const resource = `${profile}\\Default\\Network\\Cookies`;
const unknown = derive('notAnOfficialChromeNetworkCapability');
function snapshot(file = resource, sid = networkCapabilitySids[0], ownerSid = currentSid) {
  return { currentSid, ancestors: [], entries: [{ path: file, ownerSid,
    isDirectory: true, isReparsePoint: false,
    rules: [{ sid: currentSid, allow: true, mask: 0x1f01ff },
      { sid, allow: true, mask: 0x1301bf, inheritanceFlags: 3, inherited: true }],
  }] };
}
function rejectsUnchanged(value, settings = config) {
  const before = structuredClone(value);
  assert.throws(() => validateSecuritySnapshot(value, settings), { code: 'PROFILE_ACL_UNSAFE' });
  assert.deepEqual(value, before);
}

test('network capability API exports exactly the five official names and derived SIDs', () => {
  assert.deepEqual([...networkCapabilityNames].sort(), [...names].sort());
  assert.equal(new Set(networkCapabilitySids).size, 5);
  assert.deepEqual([...networkCapabilitySids], networkCapabilityNames.map(derive));
  assert.deepEqual(names.map(derive), fixedSids);
});

test('actualWin KernelBase derives all five capability SIDs independently', { skip: process.platform !== 'win32' }, async () => {
  const result = await windowsQuery(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class NetworkCapabilityOracle {
 [DllImport("KernelBase.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr caps, out uint capCount);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static void FreeSids(IntPtr array, uint count) {
  if (array == IntPtr.Zero) return;
  try { for (uint i=0; i<count; i++) { IntPtr sid=Marshal.ReadIntPtr(array, checked((int)i*IntPtr.Size)); if(sid!=IntPtr.Zero) LocalFree(sid); } }
  finally { LocalFree(array); }
 }
 public static string[] Derive(string name) {
  IntPtr groups=IntPtr.Zero, caps=IntPtr.Zero; uint ng=0, nc=0;
  try {
   if(!DeriveCapabilitySidsFromName(name,out groups,out ng,out caps,out nc)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   string[] result=new string[nc];
   for(uint i=0;i<nc;i++) result[i]=new SecurityIdentifier(Marshal.ReadIntPtr(caps,checked((int)i*IntPtr.Size))).Value;
   return result;
  } finally { try { FreeSids(groups,ng); } finally { FreeSids(caps,nc); } }
 }
}
'@
@{entries=@($q.names | ForEach-Object { @{name=$_;sids=@([NetworkCapabilityOracle]::Derive($_))} })}|ConvertTo-Json -Depth 5 -Compress
`, { names }, { timeout: 30000 });
  assert.equal(result.entries.length, 5);
  for (const entry of result.entries) assert.deepEqual(entry.sids, [fixedSids[names.indexOf(entry.name)]]);
});

for (const area of ['Cache', 'Network', 'Shared Dictionary', 'Safe Browsing Network']) {
  test(`network scope accepts only Default/${area} and descendants, case insensitive`, () => {
    for (const suffix of ['', '\\child', '\\nested\\file']) {
      assert.equal(isNetworkResource(`${profile}\\Default\\${area}${suffix}`, profile), true);
      assert.equal(isNetworkResource(`${profile}\\Default\\${area}${suffix}`.toUpperCase(), profile), true);
    }
  });
}
for (const file of [profile, `${profile}\\Default`, `${profile}\\Network\\file`,
  `${profile}\\Profile 1\\Network\\file`, `${profile}\\Default\\NetworkExtra\\file`,
  `${profile}\\Default\\Cache\\..\\..\\Preferences`, 'C:\\outside\\Default\\Network\\file',
  `${profile}-other\\Default\\Network\\file`, 'D:\\fixture\\profile\\Default\\Network\\file']) {
  test(`network scope rejects boundary ${file}`, () => assert.equal(isNetworkResource(file, profile), false));
}
test('explicit excluded file and directory descendants override resource scope', () => {
  const directory = `${profile}\\Default\\Network\\tasks`;
  for (const file of [directory, `${directory}\\journal.jsonl`, `${directory}\\nested\\lock`]) {
    assert.equal(isNetworkResource(file, profile, [directory.toUpperCase()]), false);
  }
  assert.equal(isNetworkResource(resource, profile, [resource]), false);
  assert.equal(isNetworkResource(`${directory}-other\\ok`, profile, [directory]), true);
});
const extensionId = 'nmmhkkegccagdldgiimedpiccmgmieda';
const extensionRoot = `${profile}\\Default\\Storage\\ext\\${extensionId}\\def`;
for (const area of ['Cache', 'Network', 'Shared Dictionary', 'Safe Browsing Network']) {
  test(`extension def/${area} permits only known resource ACEs`, () => {
    for (const suffix of ['', '\\child', '\\nested\\file']) {
      const file = `${extensionRoot}\\${area}${suffix}`;
      assert.equal(isNetworkResource(file, profile), true);
      assert.equal(isNetworkResource(file.toUpperCase(), profile), true);
      for (const sid of networkCapabilitySids) {
        const value = snapshot(file, sid);
        assert.equal(validateSecuritySnapshot(value, config), value);
        rejectsUnchanged(snapshot(file, sid, sid));
      }
      for (const sid of ['S-1-1-0', 'S-1-5-32-545', unknown, 'S-1-15-2-1']) rejectsUnchanged(snapshot(file, sid));
      rejectsUnchanged(snapshot(file), { profile, excludedPaths: [file] });
    }
  });
}
test('extension excluded directory protects all network resource descendants', () => {
  for (const area of ['Cache', 'Network', 'Shared Dictionary', 'Safe Browsing Network']) {
    const file = `${extensionRoot}\\${area}\\nested\\file`;
    assert.equal(isNetworkResource(file, profile, [extensionRoot]), false);
    rejectsUnchanged(snapshot(file), { profile, excludedPaths: [extensionRoot] });
  }
});
const invalidExtensionPaths = [
  ...['a'.repeat(31), 'a'.repeat(33), 'q'.repeat(32), '0'.repeat(32), `${'a'.repeat(31)}-`].map(id =>
    `${profile}\\Default\\Storage\\ext\\${id}\\def\\Cache\\file`),
  ...['other', 'partition', 'default', 'def-other'].map(partition =>
    `${profile}\\Default\\Storage\\ext\\${extensionId}\\${partition}\\Cache\\file`),
  `${profile}\\Default\\Storage`, `${profile}\\Default\\Storage\\ext`,
  `${profile}\\Default\\Storage\\ext\\${extensionId}`, extensionRoot,
  `${extensionRoot}\\Preferences`, `${extensionRoot}\\CacheExtra\\file`,
  `${profile}\\Default\\Storage\\other\\${extensionId}\\def\\Network\\file`,
  `${profile}\\Profile 1\\Storage\\ext\\${extensionId}\\def\\Cache\\file`,
];
for (const file of invalidExtensionPaths) {
  test(`extension boundary refuses same known capability: ${file}`, () => {
    assert.equal(isNetworkResource(file, profile), false);
    for (const sid of networkCapabilitySids) rejectsUnchanged(snapshot(file, sid));
  });
}
for (const sid of networkCapabilitySids) {
  test(`known capability allowed only as resource ACE ${sid}`, () => {
    const value = snapshot(resource, sid);
    assert.equal(validateSecuritySnapshot(value, config), value);
    rejectsUnchanged(snapshot(profile, sid));
    rejectsUnchanged(snapshot(`${profile}\\Default`, sid));
    rejectsUnchanged(snapshot(resource, sid, sid));
    for (const file of [profile, `${profile}\\Default`, `${profile}\\Default\\Cache\\file`,
      `${profile}\\Default\\Shared Dictionary\\file`, 'C:\\outside\\file']) {
      rejectsUnchanged(snapshot(file, currentSid, sid));
    }
    rejectsUnchanged(snapshot(resource, sid), {});
    const ancestor = snapshot(resource, sid);
    ancestor.ancestors = ancestor.entries;
    ancestor.entries = snapshot(profile, currentSid).entries;
    rejectsUnchanged(ancestor);
  });
}
for (const sid of ['S-1-1-0', 'S-1-5-32-545', 'S-1-15-2-1', 'S-1-15-2-2', unknown]) {
  test(`resource never grants broad/unknown principal ${sid}`, () => {
    rejectsUnchanged(snapshot(resource, sid));
    const mixed = snapshot();
    mixed.entries[0].rules.push({ sid, allow: true, mask: 1 });
    rejectsUnchanged(mixed);
  });
}
test('snapshot explicit excluded paths override network exception', () => {
  for (const excluded of [resource, `${profile}\\Default\\Network`]) {
    rejectsUnchanged(snapshot(), { profile, excludedPaths: [excluded] });
  }
});

test('even a known network capability cannot gain permission, ownership or delete-child administration', () => {
  for (const sid of networkCapabilitySids) for (const mask of [0x40000, 0x80000, 0x40, 0x1f01ff, 0x10000000]) {
    const value = snapshot(resource, sid);
    value.entries[0].rules[1].mask = mask;
    rejectsUnchanged(value);
  }
});

for (const [label, mask] of [['GR', 0x80000000], ['GW', 0x40000000], ['GX', 0x20000000], ['GA', 0x10000000]]) {
  test(`generic ${label} never bypasses resource confidentiality or scope`, () => {
    for (const encoded of new Set([mask, mask | 0])) {
      for (const sid of ['S-1-1-0', 'S-1-5-32-545', unknown, 'S-1-15-2-1']) {
        for (const file of [resource, `${extensionRoot}\\Cache\\file`]) {
          const value = snapshot(file);
          value.entries[0].rules.push({ sid, allow: true, mask: encoded });
          rejectsUnchanged(value);
          const projected = snapshot(file);
          projected.entries[0].rules.push({ sid, allow: true, mask: encoded, inheritOnly: true, inheritanceFlags: 3 });
          rejectsUnchanged(projected);
        }
      }
      const outside = snapshot(`${profile}\\Default\\Preferences`);
      outside.entries[0].rules[1].mask = encoded;
      rejectsUnchanged(outside);
      const allowed = snapshot(resource);
      allowed.entries[0].rules[1].mask = encoded;
      if (label === 'GA') rejectsUnchanged(allowed);
      else assert.equal(validateSecuritySnapshot(allowed, config), allowed);
      rejectsUnchanged(allowed, { profile, excludedPaths: [`${profile}\\Default\\Network`] });
    }
  });
}
