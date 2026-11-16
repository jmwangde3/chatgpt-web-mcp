import { windowsQuery } from '../src/shared/windows-security.js';

// Only initialize a test-owned, freshly created empty root, never a real profile.
export async function secureNewFixture(directory) {
  if (process.platform !== 'win32') return;
  await windowsQuery(`
$item=Get-Item -Force -LiteralPath $q.directory
if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'not a regular fixture directory'}
if(@(Get-ChildItem -Force -LiteralPath $q.directory).Count -ne 0){throw 'fixture directory must be empty'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($sid)
$inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
foreach($value in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $principal=New-Object Security.Principal.SecurityIdentifier($value)
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $q.directory -AclObject $acl
@{secured=$true}|ConvertTo-Json -Compress
`, { directory });
}
