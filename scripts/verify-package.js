import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const args = process.platform === 'win32' ? ['/d','/s','/c','npm pack --dry-run --json'] : ['pack','--dry-run','--json'];
const output = execFileSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const [pack] = JSON.parse(output);
const files = pack.files.map(file => file.path.replaceAll('\\', '/'));
const required = [
  'skills/web-chat/SKILL.md', 'skills/gh-review/SKILL.md',
  'skills/gh-review/references/code-review-protocol.md',
  'skills/gh-review/references/github-review-workflow.md',
  'skills/local-review/SKILL.md',
  'skills/local-review/references/local-review-workflow.md', 'docs/REVIEW_SKILLS.md',
  'src/shared/data-security.js', 'src/shared/stop-guard.js', 'src/shared/locks.js', 'src/shared/windows-capabilities.js',
];
const missing = required.filter(file => !files.includes(file));
const forbidden = files.filter(file => /(?:^|\/)(?:\.v21-private|\.deployment-evidence|chrome-profile|backups?|node_modules)(?:\/|$)/i.test(file) || /(?:^|\/)(?:\.env|tasks\.json|browser-state\.json|runtime-state\.json|config\.toml)(?:$|\.bak)/i.test(file));
const protocols = files.filter(file => file.endsWith('/code-review-protocol.md'));
if (missing.length || forbidden.length || protocols.length !== 1) {
  console.error(JSON.stringify({ ok: false, missing, forbidden, protocol_count: protocols.length }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, package: pack.filename, file_count: files.length, required, files }, null, 2));
