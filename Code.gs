// ============================================================
//  NET WORTH TRACKER — Google Apps Script Backend v3
//  Uses GET-only requests to avoid CORS issues
// ============================================================

const ALLOWED_EMAILS = [
  'kennedy.putra.kusumo@gmail.com',
  'anandatikacai@gmail.com',
];
const CLIENT_ID = '468703441147-16782cttqb9in18ttpkihtconlbdr525.apps.googleusercontent.com';
const DEV_TOKEN  = 'nw-local-dev-kjk-2025';

function verifyAndGetEmail_(idToken) {
  if (!idToken) return null;
  if (idToken === DEV_TOKEN) return 'kennedy.putra.kusumo@gmail.com';
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const padding = '===='.slice((parts[1].length % 4) || 4);
    const raw = Utilities.base64DecodeWebSafe(parts[1] + padding);
    const p = JSON.parse(Utilities.newBlob(raw).getDataAsString());
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(p.iss)) return null;
    if (p.aud !== CLIENT_ID) return null;
    if ((p.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return (p.email_verified === true || p.email_verified === 'true') ? p.email : null;
  } catch(e) { return null; }
}

// ── Sheet name constants ─────────────────────────────────────
const SHEET_NAME_ACCOUNTS   = 'Accounts';
const SHEET_NAME_RECORDS    = 'Records';
const SHEET_NAME_MILESTONES = 'Milestones';
const SHEET_NAME_SETTINGS   = 'Settings';
const SHEET_NAME_TARGETS    = 'Targets';
const SHEET_NAME_CASHFLOWS  = 'Cashflows';

function ensureSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemas = {
    [SHEET_NAME_ACCOUNTS]:   ['id','name','currency','liquidity','risk','class','type','notes','createdTs','growthRate'],
    [SHEET_NAME_RECORDS]:    ['id','accountId','amount','ts'],
    [SHEET_NAME_MILESTONES]: ['id','ts','label','summaryJson','isBaseline'],
    [SHEET_NAME_SETTINGS]:   ['key','value'],
    [SHEET_NAME_TARGETS]:    ['id','label','amount','currency','targetTs','inflationAdjusted','createdTs'],
    [SHEET_NAME_CASHFLOWS]:  ['id','name','amount','currency','type','category','frequency','date','startDate','endDate','notes'],
  };
  for (const [name, headers] of Object.entries(schemas)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length)
        .setBackground('#1a1f2e')
        .setFontColor('#c9a96e')
        .setFontWeight('bold');
    } else {
      // Migrate existing sheets: append any missing columns
      ensureColumns_(sheet, headers);
    }
  }
}

// Appends any headers not yet present in the sheet's first row.
function ensureColumns_(sheet, requiredHeaders) {
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
    : [];
  requiredHeaders.forEach(h => {
    if (!existing.includes(h)) {
      const col = existing.length + 1;
      const cell = sheet.getRange(1, col);
      cell.setValue(h);
      cell.setBackground('#1a1f2e').setFontColor('#c9a96e').setFontWeight('bold');
      existing.push(h);
    }
  });
}

function makeResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── All traffic goes through doGet — avoids CORS entirely ────
function doGet(e) {
  try {
    const email = verifyAndGetEmail_(e.parameter.idToken || '');
    if (!ALLOWED_EMAILS.includes(email)) {
      return makeResponse({ error: 'Unauthorized' });
    }
    ensureSheets();
    const action = e.parameter.action;
    const p = e.parameter;

    try {
      switch (action) {
        case 'getAll':           return makeResponse(getAllData());
        // Accounts
        case 'addAccount':       return makeResponse(addAccount(JSON.parse(p.data)));
        case 'updateAccount':    return makeResponse(updateAccount(JSON.parse(p.data)));
        case 'deleteAccount':    return makeResponse(deleteAccount(p.id));
        // Records
        case 'addRecord':        return makeResponse(addRecord(JSON.parse(p.data)));
        case 'deleteRecord':     return makeResponse(deleteRecord(p.id));
        // Milestones
        case 'addMilestone':     return makeResponse(addMilestone(JSON.parse(p.data)));
        case 'updateMilestone':  return makeResponse(updateMilestone(JSON.parse(p.data)));
        case 'deleteMilestone':  return makeResponse(deleteMilestone(p.id));
        case 'setBaseline':      return makeResponse(setBaseline(p.id));
        // Targets
        case 'addTarget':        return makeResponse(addTarget(JSON.parse(p.data)));
        case 'updateTarget':     return makeResponse(updateTarget(JSON.parse(p.data)));
        case 'deleteTarget':     return makeResponse(deleteTarget(p.id));
        // Cashflows
        case 'addCashflow':      return makeResponse(addCashflow(JSON.parse(p.data)));
        case 'updateCashflow':   return makeResponse(updateCashflow(JSON.parse(p.data)));
        case 'deleteCashflow':   return makeResponse(deleteCashflow(p.id));
        // Settings
        case 'setSetting':       return makeResponse(setSetting(p.key, p.value));
        default:                 return makeResponse({ error: 'Unknown action: ' + action });
      }
    } catch(err) {
      return makeResponse({ error: err.toString() });
    }
  } catch(err) {
    return makeResponse({ error: err.toString() });
  }
}

// ── Read all ─────────────────────────────────────────────────
function getAllData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const accounts   = sheetToObjects(ss.getSheetByName(SHEET_NAME_ACCOUNTS));
  const records    = sheetToObjects(ss.getSheetByName(SHEET_NAME_RECORDS));
  const milestones = sheetToObjects(ss.getSheetByName(SHEET_NAME_MILESTONES)).map(m => ({
    ...m,
    summary:    safeJson(m.summaryJson),
    isBaseline: m.isBaseline === 'TRUE' || m.isBaseline === true,
  }));

  // Hydrate records onto accounts
  const recByAccount = {};
  for (const r of records) {
    if (!recByAccount[r.accountId]) recByAccount[r.accountId] = [];
    recByAccount[r.accountId].push({ id: r.id, ts: Number(r.ts), amount: Number(r.amount) });
  }
  const hydratedAccounts = accounts.map(a => ({
    ...a, records: recByAccount[a.id] || [],
  }));

  const baseline = milestones.find(m => m.isBaseline);

  // Targets (sheet may not exist yet)
  const targetSheet = ss.getSheetByName(SHEET_NAME_TARGETS);
  const targets = targetSheet ? sheetToObjects(targetSheet).map(t => ({
    ...t,
    amount:            Number(t.amount),
    targetTs:          Number(t.targetTs),
    inflationAdjusted: t.inflationAdjusted === true || t.inflationAdjusted === 'TRUE',
  })) : [];

  // Cashflows (sheet may not exist yet)
  const cfSheet = ss.getSheetByName(SHEET_NAME_CASHFLOWS);
  const cashflows = cfSheet ? sheetToObjects(cfSheet).map(cf => ({
    ...cf,
    amount:    Number(cf.amount),
    date:      cf.date      ? Number(cf.date)      : null,
    startDate: cf.startDate ? Number(cf.startDate) : null,
    endDate:   cf.endDate   ? Number(cf.endDate)   : null,
  })) : [];

  return {
    ok: true,
    accounts:   hydratedAccounts,
    milestones,
    targets,
    cashflows,
    baselineId: baseline ? baseline.id : null,
    settings:   getSettings(),
  };
}

// ── Accounts ─────────────────────────────────────────────────
function addAccount(acc) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_ACCOUNTS);
  sheet.appendRow([acc.id, acc.name, acc.currency, acc.liquidity, acc.risk, acc.class, acc.type, acc.notes || '', acc.createdTs || Date.now(), acc.growthRate || 0]);
  return { ok: true };
}

function updateAccount(acc) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_ACCOUNTS);
  const row = findRowById(sheet, acc.id);
  if (!row) return { ok: false, error: 'Account not found' };
  sheet.getRange(row, 1, 1, 10).setValues([[acc.id, acc.name, acc.currency, acc.liquidity, acc.risk, acc.class, acc.type, acc.notes || '', acc.createdTs || Date.now(), acc.growthRate || 0]]);
  return { ok: true };
}

function deleteAccount(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  deleteRowById(ss.getSheetByName(SHEET_NAME_ACCOUNTS), id);
  // Also delete all records for this account
  const recSheet = ss.getSheetByName(SHEET_NAME_RECORDS);
  const data = recSheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(id)) recSheet.deleteRow(i + 1);
  }
  return { ok: true };
}

// ── Records ──────────────────────────────────────────────────
function addRecord(rec) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_RECORDS);
  sheet.appendRow([rec.id, rec.accountId, rec.amount, rec.ts]);
  return { ok: true };
}

function deleteRecord(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_RECORDS);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) { sheet.deleteRow(i + 1); break; }
  }
  return { ok: true };
}

// ── Milestones ───────────────────────────────────────────────
function addMilestone(m) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_MILESTONES);
  sheet.appendRow([m.id, m.ts, m.label || '', JSON.stringify(m.summary), false]);
  return { ok: true };
}

function updateMilestone(m) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_MILESTONES);
  const row = findRowById(sheet, m.id);
  if (!row) return { ok: false, error: 'Milestone not found' };
  const isBaseline = sheet.getRange(row, 5).getValue();
  sheet.getRange(row, 1, 1, 5).setValues([[m.id, m.ts, m.label || '', JSON.stringify(m.summary), isBaseline]]);
  return { ok: true };
}

function deleteMilestone(id) {
  deleteRowById(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_MILESTONES), id);
  return { ok: true };
}

function setBaseline(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_MILESTONES);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    sheet.getRange(i + 1, 5).setValue(String(data[i][0]) === String(id));
  }
  return { ok: true };
}

// ── Targets ──────────────────────────────────────────────────
function addTarget(t) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_TARGETS);
  sheet.appendRow([t.id, t.label || '', t.amount, t.currency || 'GBP', t.targetTs || '', t.inflationAdjusted || false, t.createdTs || '']);
  return { ok: true };
}

function updateTarget(t) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_TARGETS);
  const row = findRowById(sheet, t.id);
  if (!row) return { ok: false, error: 'Target not found' };
  sheet.getRange(row, 1, 1, 7).setValues([[t.id, t.label || '', t.amount, t.currency || 'GBP', t.targetTs || '', t.inflationAdjusted || false, t.createdTs || '']]);
  return { ok: true };
}

function deleteTarget(id) {
  deleteRowById(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_TARGETS), id);
  return { ok: true };
}

// ── Cashflows ────────────────────────────────────────────────
function addCashflow(cf) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_CASHFLOWS);
  sheet.appendRow([
    cf.id, cf.name, cf.amount, cf.currency, cf.type, cf.category || '',
    cf.frequency, cf.date || '', cf.startDate || '', cf.endDate || '', cf.notes || '',
  ]);
  return { ok: true };
}

function updateCashflow(cf) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_CASHFLOWS);
  const row = findRowById(sheet, cf.id);
  if (!row) return { ok: false, error: 'Cashflow not found' };
  sheet.getRange(row, 1, 1, 11).setValues([[
    cf.id, cf.name, cf.amount, cf.currency, cf.type, cf.category || '',
    cf.frequency, cf.date || '', cf.startDate || '', cf.endDate || '', cf.notes || '',
  ]]);
  return { ok: true };
}

function deleteCashflow(id) {
  deleteRowById(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_CASHFLOWS), id);
  return { ok: true };
}

// ── Settings ─────────────────────────────────────────────────
function getSettings() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_SETTINGS);
  const out = {};
  for (const r of sheetToObjects(sheet)) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_SETTINGS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(key)) {
      sheet.getRange(i + 1, 2).setValue(value);
      return { ok: true };
    }
  }
  sheet.appendRow([key, value]);
  return { ok: true };
}

// ── Utilities ────────────────────────────────────────────────
function sheetToObjects(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function findRowById(sheet, id) {
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return i + 1;
  }
  return null;
}

function deleteRowById(sheet, id) {
  const row = findRowById(sheet, id);
  if (row) sheet.deleteRow(row);
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}