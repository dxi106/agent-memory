import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "agentmem";
const KEYCHAIN_ACCOUNT = "anthropic";
const SETUP_HINT =
  "security add-generic-password -s agentmem -a anthropic -T /usr/bin/security -w";

async function defaultRunSecurity(service, account) {
  return execFileAsync("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
}

function defaultOnError(err) {
  process.stderr.write(`[agentmem] keychain lookup failed: ${err.message}\n`);
}

// Reads a password from the macOS login keychain via the `security` CLI.
// Returns the trimmed value, or null if the entry doesn't exist / lookup fails.
// Uses execFile (no shell), so service/account names aren't interpreted.
//
// Exit code 44 from `security find-generic-password` means "item not found" —
// the normal "not set up yet" case. Any other failure (ENOENT for the binary,
// ACL denial, daemon down) is surfaced via onError so the launchd cron log
// shows a real diagnostic instead of a silent miss.
export async function readKeychainPassword(service, account, opts = {}) {
  const runSecurity = opts.runSecurity ?? defaultRunSecurity;
  const onError = opts.onError ?? defaultOnError;
  try {
    const { stdout } = await runSecurity(service, account);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch (err) {
    if (err.code !== 44) onError(err);
    return null;
  }
}

// Resolves the Anthropic API key for `agentmem reflect`.
// Order:
//   1. AGENTMEM_API_KEY env var (escape hatch — deliberately NOT ANTHROPIC_API_KEY
//      so it doesn't collide with Claude Code's own auth in the same shell)
//   2. macOS Keychain entry { service: "agentmem", account: "anthropic" }
//   3. Throw a clear error that includes the keychain setup command
export async function resolveApiKey({ env = process.env, keychainReader = readKeychainPassword } = {}) {
  const fromEnv = env.AGENTMEM_API_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  let fromKeychain = null;
  try {
    fromKeychain = await keychainReader(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    fromKeychain = null;
  }
  if (fromKeychain) return fromKeychain;

  throw new Error(
    "No Anthropic API key found.\n" +
      "Either set AGENTMEM_API_KEY in your environment, or store the key in the macOS Keychain:\n" +
      `    ${SETUP_HINT}\n` +
      "(You will be prompted to paste the key; it is not echoed and does not land in shell history.)",
  );
}
