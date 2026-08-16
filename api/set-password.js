import { getSession, setLocationPassword } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    if (session.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can reset passwords' });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { role, newPassword } = body || {};

    if (role !== 'general' && role !== 'admin') {
      res.status(400).json({ error: 'Invalid password type' });
      return;
    }

    const pw = String(newPassword || '').trim();
    if (!/^\d{5}$/.test(pw)) {
      res.status(400).json({ error: 'Password must be exactly 5 digits' });
      return;
    }

    // Always scoped to the admin's own signed-in location -- never a
    // location id passed in from the client.
    await setLocationPassword(session.locationId, role, pw);
    res.status(200).json({ ok: true, role });
  } catch (err) {
    console.error('SET PASSWORD ERROR:', err);
    res.status(500).json({ error: 'Could not reset password', detail: String(err && err.message || err) });
  }
}
