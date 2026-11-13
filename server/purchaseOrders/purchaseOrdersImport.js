'use strict';

// Pure server-side validation/planning. No database writes or key allocation.
// A future API must retain the preview server-side; never trust a client-supplied
// plan. Recheck against locked current rows inside the eventual write transaction.
const calculations=require('../public/shared/purchase-calculations');
const columns = require('../public/shared/purchase-columns');
const workbook = require('../public/shared/purchase-workbook');
// Cot chi doc duoc danh dau `ro` trong purchase-columns.js — mot nguon duy nhat,
// khong lap danh sach ten cot o hai noi nhu truoc.
const writable = columns.filter(c => !c.d && !c.m && !c.ro);
const byKey = new Map(writable.map(c => [c.k, c]));
const keyPattern = /^D\d{5,}(?:\.(?:01|02))*$/;
const integerFields = new Set(['qtyPerCarton', 'cartonCount']);
const blank = value => value == null || value === '';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function version(row) { return row.version ?? row.v; }
function comparable(value, col) {
  return blank(value) ? null : workbook.numericTypes.has(col.t) ? Number(value) : String(value);
}
function prepareRows(sourceRows, existingRows, { listedAt = today(), snapshot = false, snapshotRevision } = {}) {
  if (!Array.isArray(sourceRows) || (!sourceRows.length && !snapshot) || sourceRows.length > 10000) throw Error('Đợt nhập phải có 1–10.000 dòng.');
  if (!Array.isArray(existingRows)) throw Error('Thiếu dữ liệu hiện hành để đối chiếu.');
  const existing = new Map(existingRows.map(row => [row.rowKey, row]));
  const counts = new Map();
  sourceRows.forEach(row => { const key = String(row.rowKey ?? '').trim(); if (key) counts.set(key, (counts.get(key) || 0) + 1); });
  const rows = sourceRows.map((source, index) => {
    const rowKey = blank(source.rowKey) ? null : String(source.rowKey).trim();
    const result = { sourceRow: source.__sourceRow || index + 2, rowKey, action: rowKey ? 'update' : 'create', errors: [], changes: [] };
    const current = rowKey ? existing.get(rowKey) : null;
    if (rowKey && !keyPattern.test(rowKey)) result.errors.push('Khóa dòng sai định dạng.');
    if (rowKey && counts.get(rowKey) > 1) result.errors.push('Khóa dòng trùng trong file.');
    if (rowKey && !current) result.errors.push(existingRows.some(row => row.rowKey.startsWith(rowKey + '.')) ? 'Khóa đã tách; xuất lại các nhánh hiện hành.' : 'Khóa dòng không tồn tại.');
    if (current && (!Number.isSafeInteger(version(current)) || version(current) < 1)) result.errors.push('Không đọc được phiên bản dòng hiện hành.');
    for (const message of Object.values(source.__cellErrors || {})) result.errors.push(String(message));
    const values = {};
    for (const col of writable) {
      const value = source[col.k];
      if (blank(value)) { if (snapshot) values[col.k] = null; continue; }
      if (workbook.numericTypes.has(col.t)) {
        const number = calculations.parse(value);
        // VC truoc duoc phep am (calculations.SIGNED); cac cot so khac khong am.
        if (!Number.isFinite(number) || number < 0 && !calculations.SIGNED.has(col.k) || Math.abs(number) > Number.MAX_SAFE_INTEGER) result.errors.push(col.l + ': số không hợp lệ.');
        else if (integerFields.has(col.k) && (!Number.isSafeInteger(number) || number <= 0)) result.errors.push(col.l + ': phải là số nguyên dương.');
        else if(col.k==='fxRate'&&number===0)result.errors.push(col.l+': phải lớn hơn 0 hoặc để trống.');else values[col.k] = number;
      } else if ((col.t === 'date'||col.t==='datetime')) {
        const date = col.t==='datetime'&&['orderedNote','shippedNote','etaNote','arrivedNote'].includes(col.k)?workbook.dateNoteValue(value,false):(col.t==='datetime'?workbook.dateTimeValue:workbook.dateValue)(value, false);
        if (!date) result.errors.push(col.l + ': ngày không hợp lệ.');
        else values[col.k] = date;
      } else {
        const text = String(value).trim();
        if (text.length > 4000) result.errors.push(col.l + ': tối đa 4.000 ký tự.');
        else if (text) values[col.k] = text;
        else if (snapshot) values[col.k] = null;
      }
    }
    const effective={...(current||{}),...values};for(const key of calculations.issues(effective).filter(k=>!['qtyPerCarton','cartonCount'].includes(k))){if(!result.errors.some(e=>e.startsWith((byKey.get(key)?.l||key)+':')))result.errors.push((byKey.get(key)?.l||key)+': số liệu vượt giới hạn tính toán hoặc không hợp lệ.')}
    if (!values.productCode) result.errors.push('Thiếu Mã SP.');
    if (!rowKey) {
      for (const key of ['productName', 'qtyPerCarton', 'cartonCount']) if (blank(values[key])) result.errors.push('Thiếu ' + byKey.get(key).l + '.');
      if (!values.listedAt) values.listedAt = listedAt;
      result.values = { ...values, contId: null };
    } else if (current) {
      result.id = current.id;
      result.expectedVersion = version(current);
      for (const [key, next] of Object.entries(values)) {
        if (comparable(current[key], byKey.get(key)) !== comparable(next, byKey.get(key))) result.changes.push({ key, label: byKey.get(key).l, before: current[key] ?? null, after: next });
      }
      if (!result.changes.length && !result.errors.length) result.action = 'unchanged';
    }
    return result;
  });
  if (snapshot) {
    const included = new Set(rows.map(row => row.rowKey).filter(Boolean));
    for (const current of existingRows) if (!included.has(current.rowKey)) rows.push({ sourceRow: null, rowKey: current.rowKey, action: 'delete', id: current.id, expectedVersion: version(current), errors: [], changes: [], values: { ...current } });
  }
  const valid = rows.every(row => row.errors.length === 0);
  return {
    valid,
    counts: { create: rows.filter(r => r.action === 'create' && !r.errors.length).length, update: rows.filter(r => r.action === 'update' && !r.errors.length).length, unchanged: rows.filter(r => r.action === 'unchanged').length, delete: rows.filter(r => r.action === 'delete').length, error: rows.filter(r => r.errors.length).length },
    rows,
    // Errors anywhere suppress every write operation, including valid rows.
    operations: valid ? rows.filter(row => row.action !== 'unchanged') : [],
    sourceRows: sourceRows.map(source => {
      const out = { rowKey: source.rowKey, __sourceRow: source.__sourceRow, __cellErrors: { ...(source.__cellErrors || {}) } };
      writable.forEach(col => { if (snapshot || !blank(source[col.k])) out[col.k] = source[col.k] ?? ''; });
      return out;
    }),
    listedAt,
    snapshot,
    snapshotRevision
  };
}

function prepareWorkbook(data, existingRows, { sheetName, ...options } = {}) {
  if (!data || !data.byteLength || data.byteLength > 10 * 1024 * 1024) throw Error('File phải có dữ liệu và không quá 10 MB.');
  const parsed = workbook.parseWorkbook(workbook.read(data), columns, sheetName);
  return { ...prepareRows(parsed.rows, existingRows, options), sheetName: parsed.sheetName, ignoredColumns: parsed.ignored };
}

function prepareSnapshotWorkbook(data, existingRows, { currentRevision, listedAt = today() } = {}) {
  if (!data || !data.byteLength || data.byteLength > 10 * 1024 * 1024) throw Error('File phải có dữ liệu và không quá 10 MB.');
  const parsed = workbook.parseImportSnapshot(data, columns);
  if (parsed.revision !== currentRevision) { const error = Error('Dữ liệu đã thay đổi sau khi tải file. Hãy tải snapshot mới rồi sửa lại.'); error.code = 'IMPORT_SNAPSHOT_STALE'; throw error; }
  return { ...prepareRows(parsed.rows, existingRows, { listedAt, snapshot: true, snapshotRevision: parsed.revision }), sheetName: 'Đặt hàng', ignoredColumns: [], fields: parsed.fields };
}

function recheckPreview(preview, currentRows) {
  if (!preview?.valid) throw Error('Toàn bộ file phải hợp lệ trước khi xác nhận.');
  const current = new Map(currentRows.map(row => [row.rowKey, row]));
  const conflicts = preview.rows.filter(row => row.rowKey && (!current.has(row.rowKey) || current.get(row.rowKey).id !== row.id || version(current.get(row.rowKey)) !== row.expectedVersion));
  if (conflicts.length) return { valid: false, code: 'VERSION_CONFLICT', conflicts: conflicts.map(row => ({ rowKey: row.rowKey, sourceRow: row.sourceRow })), operations: [] };
  const currentKeys = new Set(currentRows.map(row => row.rowKey));
  const missing = preview.snapshot ? preview.rows.filter(row => row.action !== 'delete' && row.rowKey && !currentKeys.has(row.rowKey)) : [];
  if (missing.length) return { valid: false, code: 'VERSION_CONFLICT', conflicts: missing.map(row => ({ rowKey: row.rowKey, sourceRow: row.sourceRow })), operations: [] };
  return prepareRows(preview.sourceRows, currentRows, { listedAt: preview.listedAt, snapshot: preview.snapshot, snapshotRevision: preview.snapshotRevision });
}

module.exports = { prepareRows, prepareWorkbook, prepareSnapshotWorkbook, recheckPreview };
