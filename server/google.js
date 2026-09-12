/**
 * Sign in with Google. ID tokens only. No client secret on this Mac.
 * Tokeninfo checks the signature; we still require a known aud and a verified email.
 */

const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
const FETCH_MS = 10_000;

function splitIds(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function allowedAudiences() {
  return [
    ...new Set([
      ...splitIds(process.env.GOOGLE_WEB_CLIENT_ID),
      ...splitIds(process.env.GOOGLE_IOS_CLIENT_ID),
      ...splitIds(process.env.GOOGLE_CLIENT_IDS),
    ]),
  ];
}

export function publicGoogleConfig() {
  return {
    clientId: String(process.env.GOOGLE_WEB_CLIENT_ID || "").trim(),
    iosClientId: String(process.env.GOOGLE_IOS_CLIENT_ID || "").trim(),
  };
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function verifyIdToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token) throw httpError("Google id token is required.", 400);

  const audiences = allowedAudiences();
  if (!audiences.length) {
    throw httpError("Google sign-in is not configured.", 503);
  }

  const url = new URL(TOKENINFO);
  url.searchParams.set("id_token", token);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    throw httpError(
      timedOut ? "Google sign-in timed out." : "Could not reach Google.",
      502
    );
  }

  if (!res.ok) {
    throw httpError("Google could not verify that sign-in.", 401);
  }

  const data = await res.json().catch(() => ({}));
  const sub = String(data.sub || "").trim();
  const email = String(data.email || "").trim();
  const verified = data.email_verified === true || data.email_verified === "true";
  if (!sub || !email) {
    throw httpError("Google account is missing email.", 401);
  }
  if (!verified) {
    throw httpError("Google email is not verified.", 401);
  }

  const aud = String(data.aud || "").trim();
  if (!audiences.includes(aud)) {
    throw httpError("Google sign-in is not for this app.", 401);
  }

  return {
    sub,
    email,
    emailVerified: true,
    name: String(data.name || "").trim(),
    picture: String(data.picture || "").trim(),
  };
}
