// Serverless function backing the shared fleet board data.
// Backed by the Upstash Redis store connected via Vercel's Storage tab.
//
// Vercel injects GJSTORAGE_KV_REST_API_URL / GJSTORAGE_KV_REST_API_TOKEN
// once the store is connected to this project (prefixed with the store's
// name, "GJSTORAGE", since it's a named Marketplace integration).

import { Redis } from '@upstash/redis';
import { getSession } from '../lib/auth.js';

const redis = new Redis({
  url: process.env.GJSTORAGE_KV_REST_API_URL,
  token: process.env.GJSTORAGE_KV_REST_API_TOKEN,
});

function stateKeyFor(locationId) {
  return `vi-fleet-state-v3:${locationId}`;
}

export default async function handler(req, res) {
  // Belt-and-suspenders: keep this endpoint out of caches/indexes too.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // The location comes from the verified session cookie, never from the
  // request body or a query param -- a signed-in user can only ever read
  // or write their own location's data.
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const key = stateKeyFor(session.locationId);

  if (req.method === 'GET') {
    try {
      const value = await redis.get(key);
      res.status(200).json({
        value: value || null,
        locationId: session.locationId,
        locationName: session.locationName,
      });
    } catch (err) {
      console.error('Redis read failed', err);
      res.status(500).json({ error: 'Failed to read fleet state' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid state payload' });
        return;
      }
      await redis.set(key, body);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Redis write failed', err);
      res.status(500).json({ error: 'Failed to save fleet state' });
    }
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'Method not allowed' });
}
