// Serverless function backing the shared fleet board data.
// Backed by the Upstash Redis store connected via Vercel's Storage tab.

import { getSession, redis } from '../lib/auth.js';

function stateKeyFor(locationId) {
  return `vi-fleet-state-v3:${locationId}`;
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  try {
    // The location comes from the verified session cookie, never from the
    // request body or a query param -- a signed-in user can only ever read
    // or write their own location's data. Both roles share the same fleet
    // data; the general/admin split only affects which UI menu items show.
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    const key = stateKeyFor(session.locationId);

    if (req.method === 'GET') {
      const value = await redis.get(key);
      res.status(200).json({
        value: value || null,
        locationId: session.locationId,
        locationName: session.locationName,
      });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid state payload' });
        return;
      }
      await redis.set(key, body);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('STATE ROUTE ERROR:', err);
    res.status(500).json({ error: 'Fleet state request failed', detail: String(err && err.message || err) });
  }
}
