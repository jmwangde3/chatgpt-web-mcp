import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BROWSER_STATE_FILE, CHROME_EXECUTABLE, HEADLESS, USER_DATA_DIR, resolveChromeExecutable, sharedBrowserEnabled } from "../config.js";

function duration(env, key, fallback, minimum) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${key} must be >= ${minimum}`);
  return value;
}

export function geminiConfig(env = process.env) {
  const dataDir = path.resolve(env.GEMINI_WEB_DATA_DIR || path.join(os.homedir(), ".gemini-web-mcp"));
  const shared = sharedBrowserEnabled(env);
  const browserState = shared ? BROWSER_STATE_FILE : path.join(dataDir, "browser-state.json");
  const profileKey = shared ? createHash('sha256').update(process.platform === 'win32' ? USER_DATA_DIR.toLowerCase() : USER_DATA_DIR).digest('hex') : null;
  return {
    url: "https://gemini.google.com/app",
    dataDir,
    profile: shared ? USER_DATA_DIR : path.resolve(env.GEMINI_WEB_PROFILE || path.join(dataDir, "chrome-profile")),
    browserState,
    ...(shared ? { browserLaunchLock: `${browserState}.launch.lock`, launchArgs: ['--start-maximized', '--new-window'], preventTerminate: true } : {}),
    taskScope: shared ? `gemini-shared-${profileKey}` : undefined,
    runtimeState: path.join(dataDir, shared ? `runtime-shared-${profileKey}.json` : "runtime-state.json"),
    operationLock: path.join(dataDir, "browser-operation.lock"),
    taskLock: path.join(env.WEB_CHAT_DATA_DIR || path.join(os.homedir(), '.web-chat-mcp'), 'gemini', 'tasks.json.lock'),
    archiveDir: path.resolve(env.GEMINI_WEB_ARCHIVE_DIR || path.join(dataDir, "conversation-context")),
    executable: shared ? CHROME_EXECUTABLE : env.GEMINI_WEB_CHROME ? path.resolve(env.GEMINI_WEB_CHROME) : resolveChromeExecutable({ env }),
    headless: shared ? HEADLESS : /^(1|true|yes)$/i.test(env.GEMINI_WEB_HEADLESS || "false"),
    actionTimeout: duration(env, "GEMINI_WEB_ACTION_TIMEOUT_MS", 20000, 1000),
    responseTimeout: duration(env, "GEMINI_WEB_RESPONSE_TIMEOUT_MS", 300000, 1000),
    sendInterval: duration(env, "GEMINI_WEB_SEND_INTERVAL_MS", 5000, 5000),
    changeInterval: duration(env, "GEMINI_WEB_CHANGE_INTERVAL_MS", 5000, 5000),
    recoveryInterval: duration(env, "GEMINI_WEB_RECOVERY_INTERVAL_MS", 300000, 300000),
  };
}
