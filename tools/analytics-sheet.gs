/**
 * SA50 RTS Ready — usage analytics sink (Google Apps Script).
 *
 * Appends usage events from the app to an "events" sheet, and auto-builds a
 * "Dashboard" tab (by-event, by-person, by-device, and an outsiders-to-review
 * filter). No location, no IP, no message contents. See ANALYTICS.md for setup.
 *
 * Deploy: from a Google Sheet → Extensions → Apps Script → paste this →
 * Deploy → New deployment → type "Web app" → Execute as "Me",
 * Who has access "Anyone" → copy the /exec URL into sync-config.js (ANALYTICS_URL).
 */

var HEADERS = ['time', 'who', 'event', 'detail', 'device', 'type', 'os', 'browser', 'installed', 'tz', 'lang', 'screen', 'ver'];

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('events') || ss.insertSheet('events');
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    var rows = (JSON.parse(e.postData.contents || '{}').rows) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      sheet.appendRow([
        r.t || '', r.who || '', r.event || '', r.detail || '', r.device || '',
        r.type || '', r.os || '', r.browser || '', r.installed ? 'app' : 'browser',
        r.tz || '', r.lang || '', r.screen || '', r.ver || ''
      ]);
    }
    ensureDashboard(ss);
    return json({ ok: true, added: rows.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet() { return ContentService.createTextOutput('SA50 RTS analytics sink is running.'); }

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Build the Dashboard once (self-updating QUERY formulas over the events tab). */
function ensureDashboard(ss) {
  if (ss.getSheetByName('Dashboard')) return;
  var d = ss.insertSheet('Dashboard', 0);
  var E = 'events!A2:M';
  d.getRange('A1').setValue('SA50 RTS — Usage Dashboard').setFontSize(14).setFontWeight('bold');
  d.getRange('A2').setFormula('="Updated " & TEXT(NOW(),"yyyy-mm-dd h:mm")');

  d.getRange('A4').setValue('Events by type').setFontWeight('bold');
  d.getRange('A5').setFormula('=IFERROR(QUERY(' + E + ',"select C, count(C) where C is not null group by C order by count(C) desc label C \'Event\', count(C) \'Count\'"),"—")');

  d.getRange('D4').setValue('Activity by person').setFontWeight('bold');
  d.getRange('D5').setFormula('=IFERROR(QUERY(' + E + ',"select B, count(B) where B is not null group by B order by count(B) desc label B \'Person\', count(B) \'Events\'"),"—")');

  d.getRange('G4').setValue('Devices seen').setFontWeight('bold');
  d.getRange('G5').setFormula('=IFERROR(QUERY(' + E + ',"select E, count(E), max(F), max(G) where E is not null group by E order by count(E) desc label E \'Device\', count(E) \'Events\', max(F) \'Type\', max(G) \'OS\'"),"—")');

  d.getRange('A' + 30).setValue('⚠ Review — desktop / non-mobile devices (possible outsiders)').setFontWeight('bold');
  d.getRange('A' + 31).setFormula('=IFERROR(QUERY(' + E + ',"select A,B,E,F,G,H where F=\'desktop\' or (G<>\'iOS\' and G<>\'Android\' and G<>\'\') order by A desc label A \'Time\', B \'Who\', E \'Device\', F \'Type\', G \'OS\', H \'Browser\'"),"none 🎉")');
}
