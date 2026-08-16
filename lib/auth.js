// Shared auth + password helpers for the fleet board.
// Not an API route itself (lives outside /api) -- imported by the routes that need it.

import crypto from 'crypto';
import { Redis } from '@upstash/redis';

// Location IDs/names and each location's starting env-var password are not
// secret by themselves -- only the password *values* are. Each location has
// a general password (everyday drivers) and an admin password (Configure
// Fleet / Passwords / Log access). Both can be reset at runtime via the
// Passwords menu, which overrides these env vars by writing to Redis.
export const LOCATIONS = {
  'vancouver-island': { name: 'Vancouver Island', generalEnvVar: 'PW_VANCOUVER_ISLAND', adminEnvVar: 'PW_ADMIN_VANCOUVER_ISLAND' },
  'vancouver':         { name: 'Vancouver',         generalEnvVar: 'PW_VANCOUVER',         adminEnvVar: 'PW_ADMIN_VANCOUVER' },
  'calgary':           { name: 'Calgary',           generalEnvVar: 'PW_CALGARY',           adminEnvVar: 'PW_ADMIN_CALGARY' },
  'edmonton':          { name: 'Edmonton',          generalEnvVar: 'PW_EDMONTON',          adminEnvVar: 'PW_ADMIN_EDMONTON' },
};

export const SESSION_COOKIE = 'gj_session';
const SESSION_HOURS = 24;
export const SESSION_MAX_AGE = SESSION_HOURS * 3600; // seconds, for the cookie

export const redis = new Redis({
  url: process.env.GJSTORAGE_KV_REST_API_URL,
  token: process.env.GJSTORAGE_KV_REST_API_TOKEN,
});

function sign(payload) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Session tokens now carry a role ('general' | 'admin') alongside the
// location, so this changed shape -- everyone will need to sign in again
// once this deploys, which is expected.
export function makeToken(locationId, role) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${locationId}.${role}.${expires}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64');
}

export function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 4) return null;
    const [locationId, role, expiresStr, sig] = parts;
    const expires = Number(expiresStr);
    if (!locationId || !role || !expires || !sig) return null;
    if (Date.now() > expires) return null;
    if (role !== 'general' && role !== 'admin') return null;
    const expectedSig = sign(`${locationId}.${role}.${expiresStr}`);
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const loc = LOCATIONS[locationId];
    if (!loc) return null;
    return { locationId, locationName: loc.name, role };
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
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

export function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifyToken(token);
}

// Redis holds any password that's been reset at runtime; falls back to the
// env var (the original bootstrap password) if nothing's been reset yet.
function pwKey(locationId, role) {
  return `vi-fleet-pw:${locationId}:${role}`;
}

export async function getLocationPassword(locationId, role) {
  const stored = await redis.get(pwKey(locationId, role));
  if (stored) return String(stored);
  const loc = LOCATIONS[locationId];
  if (!loc) return null;
  const envVar = role === 'admin' ? loc.adminEnvVar : loc.generalEnvVar;
  return process.env[envVar] || null;
}

export async function setLocationPassword(locationId, role, newPassword) {
  await redis.set(pwKey(locationId, role), newPassword);
}
