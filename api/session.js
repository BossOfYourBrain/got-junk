import { getSession } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const session = getSession(req);
  if (!session) {
    res.status(200).json({ authenticated: false });
    return;
  }
  res.status(200).json({
    authenticated: true,
    locationId: session.locationId,
    locationName: session.locationName,
  });
}
