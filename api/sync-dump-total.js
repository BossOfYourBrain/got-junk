// Writes today's dump total (as a formula) into column R, and today's
// Google Review count (a plain integer) into column W, of the linked
// "Ops Scorecard" Google Sheet -- both in one batched write, since they
// share the same row and the same "did we find today's row" safety checks.
//
// Also pushes each individual's *own* today's Google Review count into the
// linked "Junk Route Metrics" spreadsheet's "Non-Route Metrics" tab --
// matching by Concatenate Name in column C (updating an existing row, or
// appending a new one), so a person's per-review credit -- not just the
// day's total -- ends up somewhere it can be tracked over time. This half
// is independent of the Ops Scorecard push above: if it's not linked yet,
// or if it fails, the Ops Scorecard sync still succeeds on its own.
//
// Triggered automatically after an expense or GR is added/removed
// (fire-and-forget from the client), and by the admin-only "Push to Sheet"
// button on the Ops tab (awaited, with feedback).
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

// Pushes today's per-person GR counts into the Junk Route Metrics
// spreadsheet. Only people whose GR records carry a valid employee number
// (i.e. picked from the roster dropdown, not the "Other" free-text
// fallback) can be resolved to a Concatenate Name and included -- that's a
// known, accepted limitation, not a bug.
async function syncJunkRouteMetrics(sheets, stateData, todayStr) {
  const link = (stateData.spreadsheetLinks || []).find(l => l.purpose === 'Junk Route Metrics');
  const spreadsheetId = link ? extractSheetId(link.url) : null;
  if (!spreadsheetId) {
    return { synced: false, reason: 'no-link' };
  }

  const roster = stateData.employeeRoster || [];
  const grLog = stateData.grLog || [];
  const todaysGr = grLog.filter(g => g.date === todayStr);

  // empNumber -> { concatenateName, count }
  const personTotals = new Map();
  function credit(empNumber) {
    if (!empNumber) return;
    const emp = roster.find(e => String(e.empNumber) === String(empNumber));
    if (!emp || !emp.concatenateName) return; // can't resolve -- skip, per known limitation
    const key = String(empNumber);
    const cur = personTotals.get(key) || { concatenateName: emp.concatenateName, count: 0 };
    cur.count += 1;
    personTotals.set(key, cur);
  }
  todaysGr.forEach(g => {
    credit(g.driverEmpNumber);
    credit(g.passengerEmpNumber);
  });

  if (personTotals.size === 0) {
    return { synced: true, peopleUpdated: 0 };
  }

  const TAB = 'Non-Route Metrics';
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const hasTab = (meta.data.sheets || []).some(s => s.properties.title === TAB);
  if (!hasTab) {
    return { synced: false, reason: 'no-tab' };
  }

  // Row 5 and above are headers; row 6 is the first data row.
  const colCRes = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${TAB}!C6:C`,
  });
  const colCValues = (colCRes.data.values || []).map(r => (r[0] || '').toString().trim());
  const nameToRow = new Map();
  colCValues.forEach((name, idx) => { if (name) nameToRow.set(name, 6 + idx); });
  let nextAppendRow = 6 + colCValues.length;

  const writes = [];
  for (const { concatenateName, count } of personTotals.values()) {
    const existingRow = nameToRow.get(concatenateName);
    if (existingRow) {
      writes.push({ range: `${TAB}!I${existingRow}`, values: [[count]] });
    } else {
      writes.push({ range: `${TAB}!C${nextAppendRow}`, values: [[concatenateName]] });
      writes.push({ range: `${TAB}!I${nextAppendRow}`, values: [[count]] });
      nameToRow.set(concatenateName, nextAppendRow);
      nextAppendRow += 1;
    }
  }

  if (writes.length > 0) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: writes },
      });
    } catch (err) {
      const attemptedRanges = writes.map(w => w.range).join(', ');
      const baseMsg = String(err && err.message || err);
      throw new Error(`${baseMsg} | Attempted ranges: ${attemptedRanges}`);
    }
  }

  return { synced: true, peopleUpdated: personTotals.size };
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

    const grLog = stateData.grLog || [];
    const grCount = grLog.filter(g => g.date === todayStr).length;

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

    // Junk Route Metrics push -- independent of the Ops Scorecard push
    // below, wrapped in its own try/catch so a problem here never blocks
    // or fails the Ops Scorecard sync.
    let junkRoute = { synced: false, reason: 'not-attempted' };
    try {
      junkRoute = await syncJunkRouteMetrics(sheets, stateData, todayStr);
    } catch (err) {
      console.error('Junk Route Metrics sync failed', err);
      junkRoute = { synced: false, reason: 'sheets-error', detail: String(err && err.message || err) };
    }

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
        res.status(200).json({ ok: false, reason: 'month-mismatch', detail, junkRoute });
        return;
      }
      if (bRowValue !== expectedDateLabel) {
        const detail = `B${row} reads "${bRowValue}", expected "${expectedDateLabel}"`;
        console.error('Dump sync date-mismatch:', detail);
        res.status(200).json({ ok: false, reason: 'date-mismatch', detail, junkRoute });
        return;
      }

      // The dump total is hard-coded into the formula text itself (e.g.
      // "=243.23/$AA5") -- no separate cell needed to hold it. The sheet
      // does the division, including showing a visible #DIV/0! if revenue
      // isn't entered yet, rather than the app pre-validating that.
      const formula = `=${dumpTotal.toFixed(2)}/$AA${row}`;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${tabTitle}!R${row}`, values: [[formula]] },
            { range: `${tabTitle}!W${row}`, values: [[grCount]] },
          ],
        },
      });

      res.status(200).json({ ok: true, dumpTotal, grCount, formula, junkRoute });
    } catch (err) {
      console.error('Sheets sync failed', err);
      res.status(200).json({ ok: false, reason: 'sheets-error', detail: String(err && err.message || err), junkRoute });
    }
  } catch (err) {
    console.error('SYNC-DUMP-TOTAL ROUTE ERROR:', err);
    res.status(500).json({ error: 'Sync failed', detail: String(err && err.message || err) });
  }
}
