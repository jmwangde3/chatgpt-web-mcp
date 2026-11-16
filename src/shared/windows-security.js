import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
export function validateSecuritySnapshot(snapshot) {
  if (!/^S-1-/.test(snapshot?.currentSid || '') || !Array.isArray(snapshot.entries) || !snapshot.entries.length) fail('PROFILE_SECURITY_UNVERIFIED', 'Windows security evidence is missing.');
  const trusted = new Set([snapshot.currentSid, 'S-1-5-18', 'S-1-5-32-544']);
  for (const item of snapshot.entries) {
    if (item.isReparsePoint) fail('PROFILE_REPARSE_POINT', 'Profile or state paths must not contain a reparse point.');
    if (!trusted.has(item.ownerSid) || !Array.isArray(item.rules) || !item.rules.length || item.rules.some(r => r.allow && r.write && !trusted.has(r.sid))) fail('PROFILE_ACL_UNSAFE', 'Profile/state ownership or write permissions are unsafe; no ACL was changed.');
  }
  return snapshot;
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
$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$q.pid)
if(-not $p){throw 'missing process'}
$tcp=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$q.port) -ErrorAction Stop)
if($tcp.Count -ne 1){throw 'ambiguous listener'}
@{pid=[int]$p.ProcessId;creationTime=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine;ownerPid=[int]$tcp[0].OwningProcess;port=[int]$tcp[0].LocalPort;address=$tcp[0].LocalAddress}|ConvertTo-Json -Compress
`;
export async function verifyWindowsProcess(expected, { query = windowsQuery } = {}) {
  if (!Number.isInteger(expected.pid) || expected.pid < 1 || !Number.isInteger(expected.port) || expected.port < 1 || expected.port > 65535) fail('BROWSER_IDENTITY_MISMATCH','Invalid PID or port.');
  const actual = await query(identityScript, {pid:expected.pid,port:expected.port});
  const tokens = String(actual.commandLine || '').match(/(?:"[^"]*"|[^\s"])+/g) || [];
  const flags = tokens.map(t=>t.replaceAll('"',''));
  const flag = name => { const values=flags.filter(t=>t.startsWith(name+'=')); return values.length === 1 ? values[0].slice(name.length+1) : ''; };
  actual.profile=flag('--user-data-dir');
  if (flag('--remote-debugging-port') !== String(expected.port) || !['127.0.0.1','::1'].includes(flag('--remote-debugging-address'))) fail('BROWSER_IDENTITY_MISMATCH','Browser command-line ownership flags did not match.');
  assertWindowsIdentity({...expected,creationTime:expected.creationTime || actual.creationTime},actual);
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
$entries=@()
foreach($p in $q.paths){
 $i=Get-Item -Force -LiteralPath $p
 $a=Get-Acl -LiteralPath $p
 $rules=@($a.Access|ForEach-Object {@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;allow=($_.AccessControlType -eq 'Allow');write=(([int64]$_.FileSystemRights -band 852310) -ne 0)}})
 $entries+=@{path=$i.FullName;isDirectory=[bool]$i.PSIsContainer;isReparsePoint=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint);ownerSid=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=$rules}
}
@{currentSid=$sid;entries=$entries}|ConvertTo-Json -Depth 8 -Compress
`;
export async function verifyWindowsPaths(config, { query = windowsQuery, allowCreate = true } = {}) {
  const directories = [...new Set([config.profile, path.dirname(config.browserState), config.runtimeState && path.dirname(config.runtimeState)].filter(Boolean).map(p=>path.resolve(p)))];
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
  for (const file of [config.browserState,config.runtimeState,config.operationLock].filter(Boolean)) { try {const info=await fs.lstat(file);if(info.isSymbolicLink())fail('PROFILE_REPARSE_POINT','State/lock is a link.');if(!info.isFile())fail('PROFILE_NOT_FILE','State/lock must be a regular file.');paths.push(file);}catch(e){if(e.code!=='ENOENT')throw e;} }
  const snapshot=await query(securityScript,{paths, initialize: [...new Set(initialize)].reverse(), ancestors:[...ancestors]});
  return validateSecuritySnapshot(snapshot);
}
