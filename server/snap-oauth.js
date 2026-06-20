/* =====================================================================
   Snap Login Kit OAuth 2.0 helper (authorization code + PKCE).
   Tokens live ONLY server-side (in the session). Secrets come from env.

   Login Kit scopes only return display name, Bitmoji avatar and external
   id — NOT friends, mutuals, location or gender. The discovery bot data
   therefore stays simulated; this module is for the real account link.
   ===================================================================== */
import crypto from 'node:crypto';

const AUTH_URL = 'https://accounts.snapchat.com/accounts/oauth2/auth';
const TOKEN_URL = 'https://accounts.snapchat.com/accounts/oauth2/token';
const ME_URL = 'https://kit.snapchat.com/v1/me';

export function isConfigured() {
  return Boolean(process.env.SNAP_CLIENT_ID && process.env.SNAP_CLIENT_SECRET);
}

/* ---- PKCE helpers ---- */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function makePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
export function randomState() {
  return base64url(crypto.randomBytes(16));
}

/* ---- build the URL we redirect the user to ---- */
export function buildAuthUrl({ state, challenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SNAP_CLIENT_ID,
    redirect_uri: process.env.SNAP_REDIRECT_URI,
    scope: process.env.SNAP_SCOPES || '',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/* ---- exchange the auth code for tokens ---- */
export async function exchangeCode({ code, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.SNAP_REDIRECT_URI,
    client_id: process.env.SNAP_CLIENT_ID,
    code_verifier: verifier,
  });
  return tokenRequest(body);
}

/* ---- refresh an expired access token ---- */
export async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.SNAP_CLIENT_ID,
  });
  return tokenRequest(body);
}

async function tokenRequest(body) {
  const basic = Buffer.from(
    `${process.env.SNAP_CLIENT_ID}:${process.env.SNAP_CLIENT_SECRET}`
  ).toString('base64');

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
    });
  } catch (err) {
    const e = new Error('network'); e.kind = 'network'; e.cause = err; throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`token_${res.status}`);
    e.kind = res.status === 400 || res.status === 401 ? 'invalid_grant' : 'token';
    e.detail = text;
    throw e;
  }
  const data = await res.json();
  // normalise: store absolute expiry so we can detect staleness cheaply
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope,
  };
}

/* ---- fetch the linked user's profile from the Me (GraphQL) API ---- */
export async function fetchProfile(accessToken) {
  const query = `{ me { externalId displayName bitmoji { avatar } } }`;
  let res;
  try {
    res = await fetch(ME_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables: {} }),
    });
  } catch (err) {
    const e = new Error('network'); e.kind = 'network'; e.cause = err; throw e;
  }
  if (res.status === 401) { const e = new Error('expired'); e.kind = 'expired'; throw e; }
  if (!res.ok) { const e = new Error('me'); e.kind = 'me'; throw e; }
  const json = await res.json();
  const me = json?.data?.me ?? {};
  return {
    externalId: me.externalId ?? null,
    displayName: me.displayName ?? 'Snapchatter',
    avatar: me.bitmoji?.avatar ?? null,
  };
}
