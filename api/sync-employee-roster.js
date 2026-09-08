// Reads the employee roster from the linked "Ops Scorecard" spreadsheet's
// "Tables" tab (columns U/V/W/AB: Emp. #, Last Name, First Name, Concatenate
// Name) and caches it into the location's own state. This powers every
// "pick a person" dropdown across the app (Checkout, Out of Service, Report
// a Problem, Edit EOD) -- the roster is never fetched live on those hot
// paths, only refreshed here, on demand, by an admin.
//
// Row 4 of the Tables tab is the header row; real employee data starts at
// row 5 (confirmed, not assumed).
//
// Admin-only, since it changes shared data used by every signed-in user at
// this location.

import { google } from 'googleapis';
import { getSession, redis } from '../lib/auth.js';

function stateKeyFor(locationId) {
  return `vi-fleet-state-v3:${locationId}`;
}

function extractSheetId(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

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
      res.status(403).json({ error: 'Admins only' });
      return;
    }

    const key = stateKeyFor(session.locationId);
    const stateData = await redis.get(key);
    if (!stateData) {
      res.status(200).json({ ok: false, reason: 'no-link' });
      return;
    }

    const link = (stateData.spreadsheetLinks || []).find(l => l.purpose === 'Ops Scorecard');
    const spreadsheetId = link ? extractSheetId(link.url) : null;
    if (!spreadsheetId) {
      res.status(200).json({ ok: false, reason: 'no-link' });
      return;
    }

    let auth;
    try {
      auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } catch (err) {
      console.error('Google auth setup failed', err);
      res.status(200).json({ ok: false, reason: 'sheets-error' });
      return;
    }

    const sheets = google.sheets({ version: 'v4', auth });

    try {
      // Confirm a "Tables" tab actually exists before trying to read from it.
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
      const hasTablesTab = (meta.data.sheets || []).some(s => s.properties.title === 'Tables');
      if (!hasTablesTab) {
        res.status(200).json({ ok: false, reason: 'no-tables-tab' });
        return;
      }

      const ranges = ['Tables!U5:W', 'Tables!AB5:AB'];
      const readRes = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
      const [uvwRange, abRange] = readRes.data.valueRanges;
      const uvwRows = uvwRange.values || [];
      const abRows = abRange.values || [];

      const roster = [];
      for (let i = 0; i < uvwRows.length; i++) {
        const row = uvwRows[i] || [];
        const empNumber = row[0] ? String(row[0]).trim() : '';
        const lastName = row[1] ? String(row[1]).trim() : '';
        const firstName = row[2] ? String(row[2]).trim() : '';
        const concatenateName = (abRows[i] && abRows[i][0]) ? String(abRows[i][0]).trim() : '';
        // Skip blank/incomplete rows (e.g. trailing empty rows in the sheet).
        if (!empNumber || !firstName) continue;
        roster.push({ empNumber, lastName, firstName, concatenateName });
      }

      stateData.employeeRoster = roster;
      await redis.set(key, stateData);

      res.status(200).json({ ok: true, count: roster.length, roster });
    } catch (err) {
      console.error('Employee roster sync failed', err);
      res.status(200).json({ ok: false, reason: 'sheets-error', detail: String(err && err.message || err) });
    }
  } catch (err) {
    console.error('SYNC-EMPLOYEE-ROSTER ROUTE ERROR:', err);
    res.status(500).json({ error: 'Roster sync failed', detail: String(err && err.message || err) });
  }
}
