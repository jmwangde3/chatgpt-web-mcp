import os from 'node:os';
import path from 'node:path';
export const browserTestTempRoot = () => process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp')
  : os.tmpdir();
