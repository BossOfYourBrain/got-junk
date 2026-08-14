// Shared auth helpers for the fleet board's location login.
// Not an API route itself (lives outside /api) — imported by the routes that need it.

import crypto from 'crypto';

// Location IDs and display names are not secret — only the passwords are.
// Each location's password lives in its own env var, checked in api/login.js.
export const LOCATIONS = {
  'vancouver-island': { name: 'Vancouver Island', abbr: 'VI', envVar: 'PW_VANCOUVER_ISLAND' },
  'vancouver':         { name: 'Vancouver',         abbr: 'VAN', envVar: 'PW_VANCOUVER' },
  'calgary':           { name: 'Calgary',           abbr: 'CAL', envVar: 'PW_CALGARY' },
  'edmonton':          { name: 'Edmonton',          abbr: 'EDM', envVar: 'PW_EDMONTON' },
};

export const SESSION_COOKIE = 'gj_session';
const SESSION_HOURS = 24;
export const SESSION_MAX_AGE = SESSION_HOURS * 3600; // seconds, for the cookie

function sign(payload) {
  // SESSION_SECRET must be set in Vercel's env vars — this fallback only
  // protects local/dev use and should never be relied on in production.
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function makeToken(locationId) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${locationId}.${expires}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64');
}

// Returns { locationId, locationName } if the token is valid and unexpired, else null.
export function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) return null;
    const [locationId, expiresStr, sig] = parts;
    const expires = Number(expiresStr);
    if (!locationId || !expires || !sig) return null;
    if (Date.now() > expires) return null;
    const expectedSig = sign(`${locationId}.${expiresStr}`);
    // Constant-time-ish comparison is overkill for a 5-digit internal PIN tool,
    // but costs nothing to do properly.
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const loc = LOCATIONS[locationId];
    if (!loc) return null;
    return { locationId, locationName: loc.name };
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

export function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifyToken(token);
}
