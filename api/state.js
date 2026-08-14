// Serverless function backing the shared fleet board data.
// Backed by the Upstash Redis store connected via Vercel's Storage tab
// (Vercel KV as a separate product no longer exists -- Marketplace storage
// runs on Upstash Redis, so we talk to it with @upstash/redis directly).
//
// Vercel injects GJSTORAGE_KV_REST_API_URL / GJSTORAGE_KV_REST_API_TOKEN
// once the store is connected to this project (prefixed with the store's
// name, "GJSTORAGE", since it's a named Marketplace integration rather
// than a default unnamed one).

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.GJSTORAGE_KV_REST_API_URL,
  token: process.env.GJSTORAGE_KV_REST_API_TOKEN,
});

const STATE_KEY = 'vi-fleet-state-v2';

export default async function handler(req, res) {
  // Belt-and-suspenders: keep this endpoint out of caches/indexes too.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'GET') {
    try {
      const value = await redis.get(STATE_KEY);
      res.status(200).json({ value: value || null });
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
      await redis.set(STATE_KEY, body);
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
