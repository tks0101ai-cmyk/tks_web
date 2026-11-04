'use strict';

// Bang doi chieu kiem ke (thay tab "KIEM KE HN T10"): ham thuan, khong doc DB.
// So dem = dong don TEAM (ca don da huy) sau khi ap phan sua tren web; ton/gia von la ton hien tai cua products.
// Danh sach ma = ma co so dem + ma co ton khac 0 ("Quen KK") + ma da co ghi chu trong dot.

const codeKey = value => String(value ?? '').replace(/\s+/gu, '').toUpperCase();
const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
// Cong so thap phan (so luong "1.5" thung...) khong de lai duoi 0.30000000000000004.
const round = value => Math.round(value * 10000) / 10000;
const editKey = (orderId, lineNo) => `${orderId}:${lineNo}`;

// Ty le kieu cot "Do KK truoc" cua sheet: tra phan so lam tron 4 so (2.3313 = 233%); mau so trong/0 -> null (sheet ra #DIV/0!).
const ratio = (numerator, denominator) => (
  denominator === null || denominator === undefined || denominator === 0 || numerator === null || numerator === undefined
    ? null : Math.round((numerator / denominator) * 10000) / 10000);
const manualOf = value => (value === null || value === undefined || value === '' ? null : num(value));
const clusterKeyOf = cluster => String(cluster || '').trim().toUpperCase();

/**
 * Cot tinh them giong tab T10: Count (O), Chenh cum (P), Do KK truoc (Q), Lan + KK truoc (R), Do kiem SG/HN (S).
 * rows: [{ diffQty, cluster, prevDiff, otherDiff }] — sua tai cho.
 */
function deriveColumns(rows) {
  const clusters = new Map();
  for (const row of rows) {
    const key = clusterKeyOf(row.cluster);
    if (!key) continue;
    const sum = clusters.get(key) || { count: 0, diff: 0, prev: 0 };
    sum.count += 1;
    sum.diff = round(sum.diff + num(row.diffQty));
    sum.prev = round(sum.prev + num(row.prevDiff));
    clusters.set(key, sum);
  }
  for (const row of rows) {
    const sum = clusters.get(clusterKeyOf(row.cluster));
    row.clusterCount = sum ? sum.count : null;
    row.clusterDiff = sum ? sum.diff : null;
    row.clusterPrevRatio = sum ? ratio(round(sum.diff + sum.prev), sum.diff) : null;
    row.prevRatio = row.prevDiff === null || row.prevDiff === undefined ? null : ratio(round(row.diffQty + row.prevDiff), row.prevDiff);
    row.otherRatio = row.otherDiff === null || row.otherDiff === undefined ? null : ratio(round(row.diffQty + row.otherDiff), row.otherDiff);
  }
  return rows;
}

function totalsOf(rows) {
  return rows.reduce((sum, row) => {
    sum.codes += 1;
    if (row.diffQty !== 0) sum.mismatched += 1;
    if (row.forgotten) sum.forgotten += 1;
    sum.diffValue += row.diffValue;
    return sum;
  }, { codes: 0, mismatched: 0, forgotten: 0, diffValue: 0 });
}

/**
 * Ap phan sua len dong goc va them dong tay. Moi dong ket qua giu `original` (so goc tu KiotViet) de so.
 * lines: [{ orderId, lineNo, orderCode, orderStatus, team, zone, spec, productCode, productName, quantity }]
 * edits: [{ id, orderId, lineNo, productCode, team, zone, spec, quantity, removed, version, updatedByName, updatedAt }]
 */
function applyLineEdits(lines, edits) {
  const bySource = new Map();
  const manual = [];
  for (const edit of edits || []) {
    if (edit.orderId === null || edit.orderId === undefined) manual.push(edit);
    else bySource.set(editKey(edit.orderId, edit.lineNo), edit);
  }
  const pick = (edited, original) => (edited === null || edited === undefined ? original : edited);
  const result = [];
  for (const line of lines || []) {
    const edit = bySource.get(editKey(line.orderId, line.lineNo));
    const original = { productCode: line.productCode, team: line.team, zone: line.zone, spec: line.spec, quantity: num(line.quantity) };
    result.push({
      orderId: line.orderId,
      lineNo: line.lineNo,
      orderCode: line.orderCode || '',
      orderStatus: line.orderStatus || '',
      productCode: codeKey(pick(edit && edit.productCode, line.productCode)),
      productName: line.productName || '',
      team: pick(edit && edit.team, line.team) || '',
      zone: pick(edit && edit.zone, line.zone) || '',
      spec: pick(edit && edit.spec, line.spec) || '',
      quantity: num(pick(edit && edit.quantity, line.quantity)),
      removed: Boolean(edit && edit.removed),
      manual: false,
      original,
      edit: edit ? editMeta(edit) : null
    });
  }
  for (const edit of manual) {
    result.push({
      orderId: null,
      lineNo: null,
      orderCode: '',
      orderStatus: '',
      productCode: codeKey(edit.productCode),
      productName: '',
      team: edit.team || '',
      zone: edit.zone || '',
      spec: edit.spec || '',
      quantity: num(edit.quantity),
      removed: Boolean(edit.removed),
      manual: true,
      original: null,
      edit: editMeta(edit)
    });
  }
  return result;
}

const editMeta = edit => ({ id: edit.id, version: edit.version, updatedByName: edit.updatedByName || '', updatedAt: edit.updatedAt || null });

/**
 * products: [{ code, name, stock, cost }];
 * tags: [{ code, cluster, isCombo, version }]; notes: [{ code, statusText, reasonText, recheckEmployeeId, version, updatedByName, updatedAt }];
 * previous: [{ code, diffQty }] — ket qua dot da dong gan nhat.
 * counterpart: [{ code, diffQty }] — SL chenh cua dot doi chieu (co so kia).
 * Tra { rows, totals }; moi dong co lines[] (da ap sua, ke ca dong bi bo) de mo chi tiet ma.
 */
// L (KK truoc sai) va M (Kiem SG/HN): so dan tay tren ghi chu ma uu tien hon so tu lay.
function pickDiffs(note, prevAuto, otherAuto) {
  const prevManual = manualOf(note && note.prevDiffManual);
  const otherManual = manualOf(note && note.otherDiffManual);
  const auto = value => (value === undefined ? null : value);
  return {
    prevDiff: prevManual !== null ? prevManual : auto(prevAuto),
    prevDiffAuto: auto(prevAuto),
    prevDiffManual: prevManual !== null,
    otherDiff: otherManual !== null ? otherManual : auto(otherAuto),
    otherDiffAuto: auto(otherAuto),
    otherDiffManual: otherManual !== null
  };
}

function buildBoard({ lines = [], edits = [], products = [], tags = [], notes = [], previous = [], counterpart = [] } = {}) {
  const codes = new Map();
  const entry = code => {
    let row = codes.get(code);
    if (!row) {
      row = { code, name: '', counted: 0, countedLines: 0, lines: [] };
      codes.set(code, row);
    }
    return row;
  };

  for (const line of applyLineEdits(lines, edits)) {
    if (!line.productCode) continue;
    const row = entry(line.productCode);
    row.lines.push(line);
    if (!row.name && line.productName) row.name = line.productName;
    if (line.removed) continue;
    row.counted = round(row.counted + line.quantity);
    row.countedLines += 1;
  }

  const productByCode = new Map();
  for (const product of products) {
    const code = codeKey(product.code);
    if (!code) continue;
    productByCode.set(code, product);
    if (num(product.stock) !== 0) entry(code);
  }
  const noteByCode = new Map();
  for (const note of notes) {
    const code = codeKey(note.code);
    if (!code) continue;
    noteByCode.set(code, note);
    entry(code);
  }
  const tagByCode = new Map(tags.map(tag => [codeKey(tag.code), tag]));
  const previousByCode = new Map(previous.map(item => [codeKey(item.code), num(item.diffQty)]));
  const counterpartByCode = new Map(counterpart.map(item => [codeKey(item.code), num(item.diffQty)]));

  const rows = [...codes.values()].map(row => {
    const product = productByCode.get(row.code);
    const tag = tagByCode.get(row.code);
    const stock = product ? num(product.stock) : 0;
    const cost = product ? num(product.cost) : 0;
    const diffQty = round(row.counted - stock);
    return {
      code: row.code,
      name: (product && product.name) || row.name,
      inKiot: Boolean(product),
      counted: row.counted,
      stock,
      cost,
      diffQty,
      diffValue: Math.round(diffQty * cost),
      forgotten: row.countedLines === 0 && stock !== 0,
      cluster: (tag && tag.cluster) || '',
      isCombo: Boolean(tag && tag.isCombo),
      tagVersion: tag ? tag.version : null,
      ...pickDiffs(noteByCode.get(row.code), previousByCode.get(row.code), counterpartByCode.get(row.code)),
      note: noteByCode.get(row.code) || null,
      lines: row.lines
    };
  });

  deriveColumns(rows);
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return { rows, totals: totalsOf(rows) };
}

// Ban chup luc dong dot (stocktake_session_results).
const toResults = board => board.rows.map(row => ({
  code: row.code, name: row.name, counted: row.counted, stock: row.stock, cost: row.cost, diffQty: row.diffQty, diffValue: row.diffValue,
  prevDiff: row.prevDiff, otherDiff: row.otherDiff
}));

module.exports = { codeKey, applyLineEdits, buildBoard, toResults, deriveColumns, totalsOf, pickDiffs, ratio };
