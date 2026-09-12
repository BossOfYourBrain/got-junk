// Uploads a client-compressed photo (already resized/compressed to a JPEG
// data URL in the browser) to Vercel Blob storage, returning a plain URL.
//
// This exists to keep photos OUT of the main app state blob. Before this,
// every photo (EOD load photos, GR screenshots) was stored as base64
// directly inside the JSON that gets saved on every action and re-fetched
// on every 5-second poll -- meaning a single truck's EOD photo made *every*
// unrelated save and poll slower, not just the one that added it. Now the
// state only ever holds a short URL string; the browser fetches the actual
// image bytes directly from Blob storage, on demand, the same way it would
// load any other image on the web.
//
// Requires a Vercel Blob store to be created and linked to this project
// (Vercel auto-provisions the BLOB_READ_WRITE_TOKEN env var when you do).

import { put } from '@vercel/blob';
import { getSession } from '../lib/auth.js';

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

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const dataUrl = body && body.dataUrl;
    if (typeof dataUrl !== 'string') {
      res.status(400).json({ error: 'Invalid photo data' });
      return;
    }

    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: 'Invalid photo data' });
      return;
    }
    const [, mimeType, base64Data] = match;
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = mimeType.split('/')[1] || 'jpg';
    const filename = `${session.locationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: mimeType,
    });

    res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    console.error('UPLOAD-PHOTO ROUTE ERROR:', err);
    res.status(500).json({ error: 'Upload failed', detail: String(err && err.message || err) });
  }
}
