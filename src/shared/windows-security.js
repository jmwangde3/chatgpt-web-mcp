import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isNetworkResource, networkCapabilitySids } from './windows-capabilities.js';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const canonical = p => typeof p === 'string' ? path.win32.toNamespacedPath(path.win32.resolve(p)).toLowerCase() : '';
export function assertWindowsIdentity(expected, actual) {
  if (!Number.isInteger(expected.pid) || expected.pid < 1 || !Number.isInteger(expected.port) || expected.port < 1 || expected.port > 65535 ||
      actual.pid !== expected.pid || actual.ownerPid !== expected.pid || actual.port !== expected.port ||
      !['127.0.0.1', '::1'].includes(actual.address) || !expected.creationTime || !actual.creationTime ||
      expected.creationTime !== actual.creationTime || !expected.executable || !expected.profile ||
      canonical(expected.executable) !== canonical(actual.executable) || canonical(expected.profile) !== canonical(actual.profile)) {
    fail('BROWSER_IDENTITY_MISMATCH', 'Browser process, creation time, executable, profile or loopback listener could not be verified. State was preserved.');
  }
  return actual;
}
export function validateSecuritySnapshot(snapshot, config = {}) {
  if (!/^S-1-/.test(snapshot?.currentSid || '') || !Array.isArray(snapshot.entries) || !snapshot.entries.length) fail('PROFILE_SECURITY_UNVERIFIED', 'Windows security evidence is missing.');
  const trusted = new Set([snapshot.currentSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);
  for (const item of [...snapshot.entries, ...(snapshot.ancestors || [])]) {
    if (item.isReparsePoint) fail('PROFILE_REPARSE_POINT', 'Profile or state paths must not contain a reparse point.');
    if (!Array.isArray(item.rules) || !item.rules.length) fail('PROFILE_ACL_UNSAFE', 'Missing DACL evidence.');
    const protectedItem = snapshot.entries.includes(item);
    const allowedCapabilities = protectedItem && isNetworkResource(item.path, config.profile, config.excludedPaths || [])
      ? new Set(networkCapabilitySids) : new Set();
    const unsafeChildren = protectedItem && item.isDirectory && [1, 2].some(flag =>
      untrustedEffectiveRights(item.rules.filter(rule => (rule.inheritanceFlags & flag) !== 0).map(rule => ({ ...rule, inheritOnly: false })), 0xF01FF, trusted, allowedCapabilities));
    if (!trusted.has(item.ownerSid) || unsafeChildren || untrustedEffectiveRights(item.rules, protectedItem ? 0xF01FF : 0xD0040, trusted, allowedCapabilities)) fail('PROFILE_ACL_UNSAFE', 'Profile/state confidentiality, integrity or ancestor permissions are unsafe; no ACL was changed.');
  }
  return snapshot;
}

// Evaluate ordered standard DACL ACEs. A hypothetical outsider has the named
// principal and Everyone; no unverified group membership is assumed to grant a
// deny. This is conservative for domain/group membership we cannot prove.
export function untrustedEffectiveRights(rules, requested, trusted = new Set(), allowedCapabilities = new Set()) {
  const candidates = [...new Set(rules.filter(r => r.allow && !r.inheritOnly && !trusted.has(r.sid)).map(r => r.sid))];
  for (const sid of candidates) {
    // Chrome grants network read/write/execute/delete, never WRITE_DAC,
    // WRITE_OWNER or DELETE_CHILD. A known capability cannot gain those rights.
    let remaining = allowedCapabilities.has(sid) ? requested & ~0x1301BF : requested;
    for (const rule of rules) {
      if (rule.inheritOnly || (rule.sid !== sid && rule.sid !== 'S-1-1-0')) continue;
      let mask = Number.isFinite(rule.mask) ? rule.mask : rule.write ? 852310 : rule.allow ? requested : 0;
      if (mask & 0x80000000) mask |= 0x120089; // FILE_GENERIC_READ
      if (mask & 0x40000000) mask |= 0x120116; // FILE_GENERIC_WRITE
      if (mask & 0x20000000) mask |= 0x1200A0; // FILE_GENERIC_EXECUTE
      if (mask & 0x10000000) mask |= 0x1F01FF; // FILE_ALL_ACCESS
      const rights = mask & remaining;
      if (rule.allow && rights) return true;
      remaining &= ~rights;
    }
  }
  return false;
}
// Constant script plus JSON stdin: no path, PID or port is interpolated as code.
export function windowsQuery(script, input, { timeout = 8000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; $env:PSModulePath=Join-Path $PSHOME Modules; [Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $q=ConvertFrom-Json ([Console]::In.ReadToEnd()); '+script], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('Windows security query exceeded its deadline.'), { code: 'SECURITY_QUERY_TIMEOUT' })); }, timeout);
    child.on('error', () => finish(Object.assign(new Error('Windows security query could not start.'), { code: 'SECURITY_QUERY_FAILED' })));
    child.stdout.on('data', b => { output += b.toString('utf8'); if (output.length > 1024*1024) {child.kill();finish(Object.assign(new Error('Security query output exceeded its bound.'),{code:'SECURITY_QUERY_FAILED'}));} });
    child.stderr.resume();
    child.on('close', code => { if (code !== 0) return finish(Object.assign(new Error('Windows security query failed; raw command line was withheld.'), {code:'SECURITY_QUERY_FAILED'})); try { finish(null, JSON.parse(output.replace(/^\uFEFF/,''))); } catch { finish(Object.assign(new Error('Windows security evidence could not be parsed.'), {code:'SECURITY_QUERY_FAILED'})); } });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(input));
  });
}
const identityScript = `
$tcp=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$q.port) -ErrorAction Stop)
if($tcp.Count -ne 1){throw 'ambiguous listener'}
$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$tcp[0].OwningProcess)
if(-not $p){throw 'missing listener process'}
@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;creationTime=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine;ownerPid=[int]$tcp[0].OwningProcess;port=[int]$tcp[0].LocalPort;address=$tcp[0].LocalAddress}|ConvertTo-Json -Compress
`;
const processInspectionScript = `
$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$q.pid)
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object {$_.LocalPort -eq [int]$q.port})
$convert={param($p) if($null -ne $p -and $p.ProcessId){@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;creationTime=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine}}}
$recorded=&$convert $p
$owners=@($listeners|ForEach-Object {$owner=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$_.OwningProcess);$item=&$convert $owner;if($item){$item.ownerPid=[int]$_.OwningProcess;$item.port=[int]$_.LocalPort;$item.address=$_.LocalAddress;$item}})
@{recorded=$recorded;listeners=$owners}|ConvertTo-Json -Depth 6 -Compress
`;

export async function inspectWindowsBrowserProcess(expected, { query = windowsQuery } = {}) {
  if (!Number.isInteger(expected?.pid) || expected.pid < 1 || !Number.isInteger(expected.port) || expected.port < 1 || expected.port > 65535 || !expected.executable || !expected.profile) return { state: 'UNKNOWN' };
  try {
    const evidence = await query(processInspectionScript, { pid: expected.pid, port: expected.port });
    if (!Array.isArray(evidence.listeners)) return { state: 'UNKNOWN' };
    if (!evidence.recorded || (typeof evidence.recorded === 'object' && !Array.isArray(evidence.recorded) && Object.keys(evidence.recorded).length === 0)) {
      if (!evidence.listeners.length) return { state: 'NOT_RUNNING' };
      if (evidence.listeners.length !== 1) return { state: 'IDENTITY_MISMATCH' };
      const identity = await verifyWindowsProcess(expected, { query: async () => evidence.listeners[0] });
      return { state: 'PROCESS_MATCHED', identity, listener_present: true };
    }
    const actual = evidence.recorded;
    const tokens = (String(actual.commandLine || '').match(/(?:"[^"]*"|[^\s"])+/g) || []).map(t => t.replaceAll('"', ''));
    const flag = name => { const values = tokens.filter(t => t.startsWith(name + '=')); return values.length === 1 ? values[0].slice(name.length + 1) : ''; };
    const address = flag('--remote-debugging-address');
    if (flag('--remote-debugging-port') !== String(expected.port) || !['127.0.0.1','::1'].includes(address)) return { state: 'IDENTITY_MISMATCH' };
    assertWindowsIdentity({ ...expected, creationTime: expected.creationTime || actual.creationTime }, {
      ...actual, profile: flag('--user-data-dir'), port: expected.port, ownerPid: actual.pid, address,
    });
    const identity = { pid: actual.pid, port: expected.port, profile: expected.profile, executable: actual.executable, creationTime: actual.creationTime };
    if (!evidence.listeners.length) return { state: 'PROCESS_MATCHED_NO_CDP', identity, listener_present: false };
    if (evidence.listeners.length !== 1) return { state: 'IDENTITY_MISMATCH' };
    await verifyWindowsProcess({ ...expected, creationTime: identity.creationTime }, { query: async () => evidence.listeners[0] });
    return { state: 'PROCESS_MATCHED', identity, listener_present: true };
  } catch (error) { return { state: error.code === 'BROWSER_IDENTITY_MISMATCH' ? 'IDENTITY_MISMATCH' : 'UNKNOWN' }; }
}

export async function verifyWindowsProcess(expected, { query = windowsQuery } = {}) {
  if (!Number.isInteger(expected.pid) || expected.pid < 1 || !Number.isInteger(expected.port) || expected.port < 1 || expected.port > 65535) fail('BROWSER_IDENTITY_MISMATCH','Invalid PID or port.');
  const actual = { ...await query(identityScript, {pid:expected.pid,port:expected.port}) };
  const tokens = String(actual.commandLine || '').match(/(?:"[^"]*"|[^\s"])+/g) || [];
  const flags = tokens.map(t=>t.replaceAll('"',''));
  const flag = name => { const values=flags.filter(t=>t.startsWith(name+'=')); return values.length === 1 ? values[0].slice(name.length+1) : ''; };
  actual.profile=flag('--user-data-dir');
  if (flag('--remote-debugging-port') !== String(expected.port) || !['127.0.0.1','::1'].includes(flag('--remote-debugging-address'))) fail('BROWSER_IDENTITY_MISMATCH','Browser command-line ownership flags did not match.');
  let verifiedPID = expected.pid;
  if (actual.pid !== expected.pid) {
    // Chrome can re-exec into a direct child. Only migrate an un-enriched
    // launch record with matching ancestry and a tightly bounded creation time.
    // Every executable/profile/port/address check below still applies.
    const delta = Date.parse(actual.creationTime) - expected.startedAt;
    if (expected.creationTime || actual.parentPid !== expected.pid || !Number.isFinite(expected.startedAt) || !Number.isFinite(delta) || delta < -1000 || delta > 10000) fail('BROWSER_IDENTITY_MISMATCH','The listener is not the recorded browser or its verified launch child.');
    verifiedPID = actual.pid;
  }
  assertWindowsIdentity({...expected,pid:verifiedPID,creationTime:expected.creationTime || actual.creationTime},actual);
  // Persist only identity metadata, never the full command line.
  return {creationTime:actual.creationTime, executable:actual.executable, profile:actual.profile, pid:actual.pid,port:actual.port};
}
const securityScript = `
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach($newPath in $q.initialize){
 $item=Get-Item -Force -LiteralPath $newPath
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'unsafe new directory'}
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($sid)))
 $acl.SetAccessRuleProtection($true,$false)
 foreach($trusted in @($sid,'S-1-5-18','S-1-5-32-544')){
  $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($trusted)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $newPath -AclObject $acl
}
foreach($ancestor in $q.ancestors){
 $item=Get-Item -Force -LiteralPath $ancestor
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse ancestor'}
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Read-SecurityEntry($p){
 $i=Get-Item -Force -LiteralPath $p
 $a=Get-Acl -LiteralPath $p
 $rules=@($a.Access|ForEach-Object {@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;allow=($_.AccessControlType -eq 'Allow');mask=[int64]$_.FileSystemRights;write=(([int64]$_.FileSystemRights -band 852310) -ne 0);inherited=[bool]$_.IsInherited;inheritOnly=[bool]($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly);inheritanceFlags=[int]$_.InheritanceFlags;propagationFlags=[int]$_.PropagationFlags}})
 return @{path=$i.FullName;isDirectory=[bool]$i.PSIsContainer;isReparsePoint=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint);ownerSid=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=$rules}
}
$entries=@($q.paths|ForEach-Object {Read-SecurityEntry $_})
$parentEntries=@($q.ancestors|ForEach-Object {Read-SecurityEntry $_})
# Scan existing descendants without following reparse points. Only unsafe
# descendants need cross the IPC boundary; large safe profiles stay bounded.
$trusted=@($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Test-UnsafeRights($rules, $resourcePath){
 $networkCapabilityAllowed=$false
 $excluded=$false
 $full=if($resourcePath){[IO.Path]::GetFullPath($resourcePath)}else{''}
 foreach($privatePath in $q.networkExcludedPaths){
  $privateFull=[IO.Path]::GetFullPath($privatePath)
  if($full.Equals($privateFull,[StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($privateFull.TrimEnd('\\')+'\\',[StringComparison]::OrdinalIgnoreCase)){$excluded=$true;break}
 }
 if($q.profilePath -and $resourcePath -and -not $excluded){
  $networkRoot=[IO.Path]::GetFullPath($q.profilePath).TrimEnd('\\')+'\\Default\\'
  $full=[IO.Path]::GetFullPath($resourcePath)
  if($full.StartsWith($networkRoot,[StringComparison]::OrdinalIgnoreCase)){
   $parts=$full.Substring($networkRoot.Length).Split('\\')
   $top=$parts[0]
   if($parts.Length -ge 5 -and $parts[0] -eq 'Storage' -and $parts[1] -eq 'ext' -and $parts[2] -match '^[a-p]{32}$' -and $parts[3] -eq 'def'){$top=$parts[4]}
   if(@('Cache','Network','Shared Dictionary','Safe Browsing Network') -contains $top){$networkCapabilityAllowed=$true}
  }
 }
 foreach($principal in @($rules|Where-Object {$_.allow -and -not $_.inheritOnly -and ($trusted -notcontains $_.sid)}|ForEach-Object {$_.sid}|Select-Object -Unique)){
  $remaining=if($networkCapabilityAllowed -and $q.networkCapabilitySids -contains $principal){0xF01FF -band (-bnot 0x1301BF)}else{0xF01FF}
  foreach($rule in $rules){
   if($rule.inheritOnly -or ($rule.sid -ne $principal -and $rule.sid -ne 'S-1-1-0')){continue}
   $mask=[int64]$rule.mask
   if($mask -band 2147483648){$mask=$mask -bor 0x120089}
   if($mask -band 1073741824){$mask=$mask -bor 0x120116}
   if($mask -band 536870912){$mask=$mask -bor 0x1200A0}
   if($mask -band 268435456){$mask=$mask -bor 0x1F01FF}
   $rights=($mask -band $remaining)
   if($rule.allow -and $rights){return $true}
   $remaining=$remaining -band (-bnot $rights)
  }
 }
 return $false
}
$unsafe=@();$checked=0
$stack=New-Object 'System.Collections.Generic.Stack[string]'
foreach($root in $q.recursiveRoots){$stack.Push($root)}
while($stack.Count -gt 0 -and $unsafe.Count -eq 0){
 $parent=$stack.Pop()
 try {$children=@(Get-ChildItem -Force -LiteralPath $parent -ErrorAction Stop)}
 catch {
  if($_.CategoryInfo.Category -eq 'ObjectNotFound' -and $q.recursiveRoots -notcontains $parent -and -not (Test-Path -LiteralPath $parent -ErrorAction Stop)){continue}
  throw
 }
 foreach($child in $children){
  $checked++;if($checked -gt 200000){throw 'security scan limit'}
  try {$entry=Read-SecurityEntry $child.FullName}
  catch {
   # Chrome can remove a cache entry between enumeration and Get-Acl. Only
   # confirmed absence is skippable; access failures and unknown errors reject.
   if($_.CategoryInfo.Category -eq 'ObjectNotFound' -and -not (Test-Path -LiteralPath $child.FullName -ErrorAction Stop)){continue}
   throw
  }
  $bad=$entry.isReparsePoint -or ($trusted -notcontains $entry.ownerSid) -or (Test-UnsafeRights $entry.rules $entry.path)
  if($entry.isDirectory){
   foreach($flag in @(1,2)){
    $projected=@($entry.rules|Where-Object {($_.inheritanceFlags -band $flag) -ne 0}|ForEach-Object {$copy=$_.Clone();$copy.inheritOnly=$false;$copy})
    if(Test-UnsafeRights $projected $entry.path){$bad=$true}
   }
  }
  if($bad){$unsafe+=,$entry;break}
  if($entry.isDirectory){$stack.Push($child.FullName)}
 }
}
@{currentSid=$sid;entries=@($entries)+@($unsafe);ancestors=$parentEntries;descendants_checked=$checked}|ConvertTo-Json -Depth 8 -Compress
`;
export async function verifyWindowsPaths(config, { query = windowsQuery, allowCreate = true } = {}) {
  const files = [config.browserState, config.runtimeState, config.operationLock, config.taskLock, config.taskJournal,
    config.runtimeState && config.runtimeState + '.lock', ...(config.protectedFiles || [])].filter(Boolean);
  const directories = [...new Set([config.profile, ...files.map(file => path.dirname(file)), ...(config.dataDirectories || [])].filter(Boolean).map(p=>path.resolve(p)))];
  const paths = [], initialize = [], ancestors = new Set();
  for (const directory of directories) {
    // Reject links/reparse points in every ancestor; check ACLs only on owned data directories.
    let current = directory;
    while (true) {
      try { const info = await fs.lstat(current); ancestors.add(current); if (info.isSymbolicLink()) fail('PROFILE_REPARSE_POINT','A profile path contains a link.'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      if (await fs.stat(path.join(current,'.git')).then(()=>true,()=>false)) fail('PROFILE_IN_REPOSITORY','Browser data must not be stored inside a repository.');
      const parent=path.dirname(current); if(parent===current) break; current=parent;
    }
    // Do not initialize permissions on existing data. Newly created directories inherit ACLs, then are verified.
    if (!allowCreate) {
      try { await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') fail('PROFILE_MISSING','Profile/state directory does not exist.'); throw error; }
    }
    const created = allowCreate ? await fs.mkdir(directory,{recursive:true}) : undefined;
    if (created) {
      let current = directory;
      while (true) { initialize.push(current); if (canonical(current) === canonical(created)) break; const parent = path.dirname(current); if (parent === current) fail('PROFILE_SECURITY_UNVERIFIED','New directory boundary could not be verified.'); current = parent; }
    }
    if (!(await fs.lstat(directory)).isDirectory()) fail('PROFILE_NOT_DIRECTORY','Profile/state parent must be a regular directory.');
    paths.push(directory);
  }
  for (const file of files) { try {const info=await fs.lstat(file);if(info.isSymbolicLink())fail('PROFILE_REPARSE_POINT','State/lock is a link.');if(!info.isFile())fail('PROFILE_NOT_FILE','State/lock must be a regular file.');paths.push(file);}catch(e){if(e.code!=='ENOENT')throw e;} }
  const excludedPaths = [...new Set([...files, ...directories.filter(directory => isNetworkResource(directory, config.profile)), ...(config.dataDirectories || []), ...(config.recursiveRoots || [])])];
  const snapshot=await query(securityScript,{paths: [...new Set(paths)], initialize: [...new Set(initialize)].reverse(), ancestors:[...ancestors], recursiveRoots: [config.profile, ...(config.recursiveRoots || [])].filter(Boolean), profilePath: config.profile, networkCapabilitySids, networkExcludedPaths: excludedPaths }, { timeout: 60000 });
  if (!Array.isArray(snapshot.ancestors) || snapshot.ancestors.length !== ancestors.size) fail('PROFILE_SECURITY_UNVERIFIED', 'Ancestor ACL evidence is incomplete; no existing permissions were changed.');
  return validateSecuritySnapshot(snapshot, { profile: config.profile, excludedPaths });
}
