/**
 * SA50 RTS Ready — usage analytics sink (Google Apps Script).
 *
 * Appends usage events to an "events" sheet and auto-builds a formatted
 * Dashboard (KPIs, by-event/person/screen, logins-per-day + chart, by-hour,
 * devices) plus "Review" (possible outsiders) and "Security" (failed PINs /
 * master 1905 uses) tabs. No location, no IP, no message contents.
 * See ANALYTICS.md for setup.
 *
 * After editing this code: Deploy → Manage deployments → Edit (pencil) →
 * Version: "New version" → Deploy  (keeps the same /exec URL).
 * Then it rebuilds on the next event, or run "SA50 Analytics → Rebuild dashboard".
 */

var DASH_VERSION = 3;
var HEADERS = ['time', 'who', 'event', 'detail', 'device', 'type', 'os', 'browser',
  'installed', 'tz', 'lang', 'screen', 'ver', 'date', 'hour', 'dow', 'session',
  'viewport', 'net', 'dark', 'referrer'];
var RED = '#E31837';
var E = 'events!A2:U';

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('events') || ss.insertSheet('events');
    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
    var rows = (JSON.parse(e.postData.contents || '{}').rows) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      sh.appendRow([r.t || '', r.who || '', r.event || '', r.detail || '', r.device || '',
        r.type || '', r.os || '', r.browser || '', r.installed ? 'app' : 'browser',
        r.tz || '', r.lang || '', r.screen || '', r.ver || '', r.date || '',
        r.hour === 0 || r.hour ? r.hour : '', r.dow || '', r.session || '',
        r.viewport || '', r.net || '', r.dark || '', r.referrer || '']);
    }
    ensureSetup(ss);
    return json({ ok: true, added: rows.length });
  } catch (err) { return json({ ok: false, error: String(err) }); }
}

function doGet() { return ContentService.createTextOutput('SA50 RTS analytics sink is running.'); }
function onOpen() { SpreadsheetApp.getUi().createMenu('SA50 Analytics').addItem('Rebuild dashboard', 'rebuildNow').addToUi(); }
function rebuildNow() { rebuildAll(SpreadsheetApp.getActiveSpreadsheet()); }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function ensureSetup(ss) {
  var d = ss.getSheetByName('Dashboard');
  var cur = d ? d.getRange('Z1').getValue() : null;
  if (String(cur) !== String(DASH_VERSION)) rebuildAll(ss);
}

/* ---------- build ---------- */
function q(sel) { return '=IFERROR(QUERY(' + E + ',"' + sel + '"),"—")'; }
function resetSheet(ss, name, index) {
  var sh = ss.getSheetByName(name); if (sh) ss.deleteSheet(sh);
  return ss.insertSheet(name, index);
}
function section(sh, a1, text) {
  sh.getRange(a1).setValue(text).setFontWeight('bold').setFontColor('#fff').setBackground('#475569');
}
function kpi(sh, a1, label, formula) {
  var c = sh.getRange(a1); c.setValue(label).setFontSize(9).setFontColor('#666');
  var v = sh.getRange(a1).offset(1, 0); v.setFormula(formula).setFontSize(20).setFontWeight ? null : null;
  v.setFontSize(20).setFontWeight('bold').setFontColor(RED);
}

function formatEvents(ss) {
  var sh = ss.getSheetByName('events') || ss.insertSheet('events');
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setFontColor('#fff').setBackground(RED);
  sh.setFrozenRows(1);
  try { sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).createFilter(); } catch (e) {}
}

function rebuildAll(ss) {
  formatEvents(ss);
  var d = resetSheet(ss, 'Dashboard', 0);
  d.getRange('A1').setValue('SA50 RTS — Usage Dashboard').setFontWeight('bold').setFontSize(16).setFontColor(RED);
  d.getRange('A2').setFormula('="Updated "&TEXT(NOW(),"ddd mmm d, h:mm am/pm")');
  d.getRange('A2').setFontColor('#888');

  kpi(d, 'A4', 'Total events', '=COUNTA(events!C2:C)');
  kpi(d, 'C4', 'People', "=COUNTA(QUERY(events!B2:B,\"select B where B is not null and B<>'(not signed in)' group by B\"))");
  kpi(d, 'E4', 'Devices', '=COUNTUNIQUE(events!E2:E)');
  kpi(d, 'G4', 'Days active', '=COUNTUNIQUE(events!N2:N)');

  section(d, 'A7', 'Events by type');
  d.getRange('A8').setFormula(q("select C, count(C) where C is not null group by C order by count(C) desc label C 'Event', count(C) 'Count'"));
  section(d, 'E7', 'Activity by person');
  d.getRange('E8').setFormula(q("select B, count(B) where B is not null and B<>'(not signed in)' group by B order by count(B) desc label B 'Person', count(B) 'Events'"));
  section(d, 'I7', 'Screens opened');
  d.getRange('I8').setFormula(q("select D, count(D) where C='screen' and D is not null group by D order by count(D) desc label D 'Screen', count(D) 'Opens'"));

  section(d, 'A34', 'Logins per day');
  d.getRange('A35').setFormula(q("select N, count(N) where C='login' and N is not null group by N order by N label N 'Day', count(N) 'Logins'"));
  section(d, 'E34', 'By hour of day');
  d.getRange('E35').setFormula(q("select O, count(O) where O is not null group by O order by O label O 'Hour', count(O) 'Events'"));
  section(d, 'I34', 'Devices seen');
  d.getRange('I35').setFormula(q("select E, count(E), max(F), max(G), max(H) where E is not null group by E order by count(E) desc label E 'Device', count(E) 'Events', max(F) 'Type', max(G) 'OS', max(H) 'Browser'"));

  for (var c = 1; c <= 12; c++) d.setColumnWidth(c, 118);
  d.setFrozenRows(2);
  d.getRange('Z1').setValue(DASH_VERSION).setFontColor('#fff');   // version marker (white on white)

  try {
    var chart = d.newChart().asColumnChart()
      .addRange(d.getRange('A35:B400'))
      .setPosition(4, 13, 0, 0)
      .setOption('title', 'Logins per day').setOption('legend', { position: 'none' })
      .setOption('width', 440).setOption('height', 260).setOption('colors', [RED])
      .build();
    d.insertChart(chart);
  } catch (e) {}

  var r = resetSheet(ss, 'Review', 1);
  r.getRange('A1').setValue('⚠ Possible outsiders — desktop / non-mobile devices').setFontWeight('bold').setFontSize(14);
  r.getRange('A3').setFormula(q("select A,B,E,F,G,H,S,U where F='desktop' or (G<>'iOS' and G<>'Android' and G<>'') order by A desc label A 'Time', B 'Who', E 'Device', F 'Type', G 'OS', H 'Browser', S 'Net', U 'Referrer'"));
  r.setFrozenRows(3); for (var c2 = 1; c2 <= 8; c2++) r.setColumnWidth(c2, 130);

  var s = resetSheet(ss, 'Security', 2);
  s.getRange('A1').setValue('🔒 Security — failed PINs & master (1905) uses').setFontWeight('bold').setFontSize(14);
  s.getRange('A3').setFormula(q("select A,B,C,E,F,G where C='pin_fail' or C='master_used' order by A desc label A 'Time', B 'Who', C 'Event', E 'Device', F 'Type', G 'OS'"));
  s.setFrozenRows(3); for (var c3 = 1; c3 <= 6; c3++) s.setColumnWidth(c3, 140);
}
