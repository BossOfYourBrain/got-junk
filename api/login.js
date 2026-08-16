import { LOCATIONS, makeToken, getLocationPassword, SESSION_COOKIE, SESSION_MAX_AGE } from '../lib/auth.js';

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

    const pw = String(password || '').trim();
    const adminPw = await getLocationPassword(locationId, 'admin');
    const generalPw = await getLocationPassword(locationId, 'general');

    // Check admin first: if a location's admin and general codes were ever
    // set to the same value, the more privileged role wins rather than
    // silently locking someone into the lower-access one.
    let role = null;
    if (adminPw && pw === String(adminPw).trim()) role = 'admin';
    else if (generalPw && pw === String(generalPw).trim()) role = 'general';

    if (!role) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    const token = makeToken(locationId, role);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`
    );
    res.status(200).json({ ok: true, locationId, locationName: loc.name, role });
  } catch (err) {
    console.error('LOGIN ROUTE ERROR:', err);
    res.status(500).json({ error: 'Login failed', detail: String(err && err.message || err) });
  }
}
