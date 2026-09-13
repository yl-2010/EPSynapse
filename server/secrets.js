/**
 * Secret Manager -> process.env at boot.
 *
 * Runs only when GOOGLE_CLOUD_PROJECT is set (App Engine sets it) and
 * SECRETS_FROM_MANAGER=1. Reads every name in SECRET_NAMES (comma list) from
 * projects/<project>/secrets/<name>/versions/latest and sets process.env[name]
 * unless it is already set. Anywhere else (the Mac with --env-file=.env) this is
 * a no-op, so index.js can call it unconditionally:
 *
 *   await loadSecrets();
 *
 * Same idea as epschedule's cron/four11.py, which reads four11_key from Secret
 * Manager, except the names are configurable so the same code runs in any
 * school-owned project.
 */

const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;

export function secretsEnabled(env = process.env) {
  return Boolean(String(env.GOOGLE_CLOUD_PROJECT || "").trim()) &&
    String(env.SECRETS_FROM_MANAGER || "").trim() === "1";
}

export function secretNames(env = process.env) {
  return String(env.SECRET_NAMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @returns {Promise<{ loaded: string[], skipped: string[], missing: string[] }>}
 */
export async function loadSecrets({ env = process.env, log = console } = {}) {
  const result = { loaded: [], skipped: [], missing: [] };
  if (!secretsEnabled(env)) return result;

  const project = String(env.GOOGLE_CLOUD_PROJECT).trim();
  const names = secretNames(env);
  if (!names.length) {
    log.warn?.("[secrets] SECRETS_FROM_MANAGER=1 but SECRET_NAMES is empty");
    return result;
  }

  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();

  for (const name of names) {
    if (!SECRET_NAME_RE.test(name)) {
      log.warn?.(`[secrets] skipping invalid secret name ${JSON.stringify(name)}`);
      result.skipped.push(name);
      continue;
    }
    if (String(env[name] ?? "").length) {
      result.skipped.push(name);
      continue;
    }
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${project}/secrets/${name}/versions/latest`,
      });
      const value = Buffer.from(version?.payload?.data || "").toString("utf8");
      if (!value) {
        result.missing.push(name);
        continue;
      }
      env[name] = value;
      result.loaded.push(name);
    } catch (err) {
      result.missing.push(name);
      log.warn?.(`[secrets] ${name}: ${err?.message || err}`);
    }
  }

  log.log?.(
    `[secrets] loaded ${result.loaded.length}, kept ${result.skipped.length} from env, missing ${result.missing.length}`
  );
  return result;
}
