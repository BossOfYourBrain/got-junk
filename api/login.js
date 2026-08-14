import { LOCATIONS, makeToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { locationId, password } = body || {};

    const loc = LOCATIONS[locationId];
    if (!loc) {
      res.status(400).json({ error: 'Unknown location' });
      return;
    }

    const expected = process.env[loc.envVar];
    if (!expected) {
      // Password env var not set for this location yet — fail closed, not open.
      console.error(`Missing env var ${loc.envVar} for location ${locationId}`);
      res.status(500).json({ error: 'Location is not configured yet — contact your admin' });
      return;
    }

    if (String(password || '').trim() !== String(expected).trim()) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    const token = makeToken(locationId);
    // Secure requires HTTPS — true on every Vercel deployment (including previews).
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`
    );
    res.status(200).json({ ok: true, locationId, locationName: loc.name });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
}
