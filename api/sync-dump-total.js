// Writes today's dump total into the linked "Ops Scorecard" Google Sheet as
// a formula -- e.g. "=243.23/$AA5" -- rather than a pre-computed percentage.
// The sheet's own formula engine handles the division (including a visible
// #DIV/0! if revenue isn't entered yet), so the app no longer reads or
// validates revenue at all.
//
// Triggered automatically after an expense is added/removed (fire-and-forget
// from the client), and by the admin-only "Push to Sheet" button on the EOD
// tab (awaited, with feedback).
//
// Every response is 200 with an {ok, reason} shape for expected/handled
// outcomes -- a non-200 is reserved for genuinely unexpected failures
// (bad session, malformed request), not for "nothing to sync yet".

import { google } from 'googleapis';
import { getSession, redis } from '../lib/auth.js';

function stateKeyFor(locationId) {
  return `vi-fleet-state-v3:${locationId}`;
}

function extractSheetId(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// All date/month/weekday calculations use the business's actual timezone,
// not the server's UTC clock -- a sync running near midnight UTC must still
// land on the correct Pacific calendar day.
const TIMEZONE = 'America/Vancouver';

function pacificDateParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { year: map.year, month: map.month, day: map.day };
}

function pacificMonthName(now) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: TIMEZONE }).format(now);
}

function pacificFullDateLabel(now) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: TIMEZONE,
  }).format(now);
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

    const stateData = await redis.get(stateKeyFor(session.locationId));
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

    const now = new Date();
    const { year, month, day } = pacificDateParts(now);
    const todayStr = `${year}-${month}-${day}`;
    const row = Number(day) + 2;

    const expenseLog = stateData.expenseLog || [];
    const dumpTotal = expenseLog
      .filter(e => e.date === todayStr)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

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
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
      const tabTitle = meta.data.sheets[0].properties.title;

      // Only reading B2 (month dropdown) and B{row} (that row's date label)
      // now -- no need to read AA at all, since the formula references it
      // directly rather than the app computing anything from its value.
      //
      // Deliberately using the default FORMATTED_VALUE here (not
      // UNFORMATTED_VALUE) -- these cells likely hold real Date values with
      // custom display formatting ("Tuesday, September 1"), and the
      // formatted text is what actually needs to match, not the underlying
      // raw serial number.
      const ranges = [`${tabTitle}!B2`, `${tabTitle}!B${row}`];
      const readRes = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
      const [b2Range, bRowRange] = readRes.data.valueRanges;
      const b2Value = String((b2Range.values && b2Range.values[0] && b2Range.values[0][0]) || '').trim();
      const bRowValue = String((bRowRange.values && bRowRange.values[0] && bRowRange.values[0][0]) || '').trim();

      const expectedMonth = pacificMonthName(now);
      const expectedDateLabel = pacificFullDateLabel(now);

      if (b2Value.toLowerCase() !== expectedMonth.toLowerCase()) {
        const detail = `B2 reads "${b2Value}", expected month "${expectedMonth}"`;
        console.error('Dump sync month-mismatch:', detail);
        res.status(200).json({ ok: false, reason: 'month-mismatch', detail });
        return;
      }
      if (bRowValue !== expectedDateLabel) {
        const detail = `B${row} reads "${bRowValue}", expected "${expectedDateLabel}"`;
        console.error('Dump sync date-mismatch:', detail);
        res.status(200).json({ ok: false, reason: 'date-mismatch', detail });
        return;
      }

      // The dump total is hard-coded into the formula text itself (e.g.
      // "=243.23/$AA5") -- no separate cell needed to hold it. The sheet
      // does the division, including showing a visible #DIV/0! if revenue
      // isn't entered yet, rather than the app pre-validating that.
      const formula = `=${dumpTotal.toFixed(2)}/$AA${row}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabTitle}!R${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[formula]] },
      });

      res.status(200).json({ ok: true, dumpTotal, formula });
    } catch (err) {
      console.error('Sheets sync failed', err);
      res.status(200).json({ ok: false, reason: 'sheets-error', detail: String(err && err.message || err) });
    }
  } catch (err) {
    console.error('SYNC-DUMP-TOTAL ROUTE ERROR:', err);
    res.status(500).json({ error: 'Sync failed', detail: String(err && err.message || err) });
  }
}
