/**
 * SA50 RTS Ready — usage analytics sink (Google Apps Script).
 *
 * Receives batched usage events from the app and appends them as rows to the
 * bound Google Sheet. No location, no IP, no message contents — just
 * who / when / device / action. See ANALYTICS.md for setup.
 *
 * Deploy: Extensions → Apps Script (from a Google Sheet) → paste this →
 * Deploy → New deployment → type "Web app" → Execute as "Me",
 * Who has access "Anyone" → copy the /exec URL into sync-config.js (ANALYTICS_URL).
 */

var HEADERS = ['time', 'who', 'event', 'detail', 'device', 'type', 'os', 'browser', 'installed', 'tz', 'lang', 'screen', 'ver'];

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('events')
             || SpreadsheetApp.getActiveSpreadsheet().insertSheet('events');
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    var payload = JSON.parse(e.postData.contents || '{}');
    var rows = payload.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      sheet.appendRow([
        r.t || '', r.who || '', r.event || '', r.detail || '', r.device || '',
        r.type || '', r.os || '', r.browser || '', r.installed ? 'app' : 'browser',
        r.tz || '', r.lang || '', r.screen || '', r.ver || ''
      ]);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: rows.length }))
                         .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

// Lets you open the /exec URL in a browser to confirm it's live.
function doGet() {
  return ContentService.createTextOutput('SA50 RTS analytics sink is running.');
}
