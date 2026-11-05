'use strict';

// Import hang loat THONG TIN KHACH (ho so trong hop Chi tiet: SDT, dia chi, dinh vi kho, so luong kho, dien tich, doi thu,
// hinh thuc ban hang, quy mo khach) tu file Excel xuat tu bang "Doanh so theo khach". Doc cot theo TEN tieu de.
// Quy tac an toan (sau su co mat SDT/dia chi 05/11/2026):
//  - O trong trong file KHONG BAO GIO xoa du lieu dang co ("Chua co" o Quy mo = trong).
//  - mode 'fill' (mac dinh): chi dien vao truong dang trong; mode 'overwrite': ghi de bang gia tri khac trong file.
//  - Khach phai co trong bang bao cao (validKeys), khong tao khach moi. Mac dinh chi xem truoc, apply moi ghi.
//  - Level gia / Khach moi KHONG nam trong luong nay (xem customerLevelExcelImport.js).

const { nameKey } = require('./businessMonths');
const rules = require('./customerProfileRules');

const CHANNEL_BY_LABEL = {
  'bán sàn': 'san', 'bán cửa hàng': 'cua_hang', 'fb ads': 'fb_ads', 'fb live': 'fb_live', 'sang tay': 'sang_tay', 'kho buôn': 'kho_buon', 'khác': 'khac'
};
const SCALE_BY_LABEL = { 'chưa có': 'none', 'nhỏ': 'small', 'vừa': 'medium', 'to': 'large', 'rất to': 'very_large' };
const SCALE_LABELS = { none: 'Chưa có', small: 'Nhỏ', medium: 'Vừa', large: 'To', very_large: 'Rất to' };
const CHANNEL_LABELS = { san: 'Bán sàn', cua_hang: 'Bán cửa hàng', fb_ads: 'FB ads', fb_live: 'FB live', sang_tay: 'Sang tay', kho_buon: 'Kho buôn', khac: 'Khác' };

// Tieu de cot (da chuan hoa) -> truong. Thieu cot nao thi truong do khong duoc dong toi.
const HEADER_FIELDS = {
  'tên khách': 'name', 'điện thoại': 'phone', 'địa chỉ': 'address', 'định vị kho': 'warehouseLocation', 'số lượng kho': 'warehouseCount',
  'diện tích': 'area', 'đối thủ': 'competitor', 'hình thức bán hàng': 'salesChannels', 'quy mô khách': 'warehouseScale'
};
const FIELDS = ['phone', 'address', 'warehouseLocation', 'warehouseCount', 'area', 'competitor', 'salesChannels', 'warehouseScale'];
const FIELD_LABELS = {
  phone: 'Điện thoại', address: 'Địa chỉ', warehouseLocation: 'Định vị kho', warehouseCount: 'Số lượng kho', area: 'Diện tích',
  competitor: 'Đối thủ', salesChannels: 'Hình thức bán hàng', warehouseScale: 'Quy mô khách'
};

const cellText = v => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    v = v.text != null ? v.text : v.result != null ? v.result : (v.richText ? v.richText.map(t => t.text).join('') : '');
  }
  return String(v).trim();
};
const headKey = v => cellText(v).normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
// Excel xuat them dau nhay dau o de giu so 0 / dau '+' (vd '+84333...'): bo di, du lieu that khong co dau nhay.
const unquote = s => s.replace(/^'+/, '').trim();
const MAX_SAMPLE = 30;

function parseWorksheet(ws) {
  const cols = {};
  ws.getRow(1).eachCell((cell, c) => { const f = HEADER_FIELDS[headKey(cell.value)]; if (f && !cols[f]) cols[f] = c; });
  if (!cols.name) throw rules.httpError(400, 'IMPORT_NO_NAME_COLUMN', 'File thiếu cột "Tên khách" ở dòng tiêu đề.');
  const present = FIELDS.filter(f => cols[f]);
  if (!present.length) throw rules.httpError(400, 'IMPORT_NO_INFO_COLUMNS', 'File không có cột thông tin khách nào (Điện thoại, Địa chỉ, Định vị kho, Số lượng kho, Diện tích, Đối thủ, Hình thức bán hàng, Quy mô khách).');
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = f => (cols[f] ? row.getCell(cols[f]).value : null);
    const name = cellText(get('name'));
    if (!name) return;
    const out = { rowNumber: n, name };
    for (const f of present) out[f] = f === 'warehouseCount' ? get(f) : cellText(get(f));
    rows.push(out);
  });
  return { rows, columns: present };
}

async function readExcelUpload(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  if (!wb.worksheets[0]) throw new Error('File Excel không có sheet nào.');
  return parseWorksheet(wb.worksheets[0]);
}

// Dong tho -> gia tri da chuan hoa (chuoi/so/mang/scale); throw httpError 400 neu sai. Truong khong co cot => bo qua.
function normalizeRow(r, columns) {
  const has = f => columns.includes(f);
  const v = {};
  if (has('phone')) v.phone = rules.normalizeProfileInput({ phone: unquote(r.phone) }).phone;
  if (has('address')) v.address = rules.normalizeProfileInput({ address: unquote(r.address) }).address;
  if (has('warehouseLocation')) v.warehouseLocation = rules.normalizeProfileInput({ warehouseLocation: r.warehouseLocation }).warehouseLocation;
  if (has('area')) v.area = rules.normalizeProfileInput({ area: r.area }).area;
  if (has('competitor')) v.competitor = rules.normalizeProfileInput({ competitor: r.competitor }).competitor;
  if (has('warehouseCount')) {
    const raw = typeof r.warehouseCount === 'object' && r.warehouseCount ? (r.warehouseCount.result ?? r.warehouseCount.text) : r.warehouseCount;
    const s = cellText(raw).replace(/,/g, '');
    v.warehouseCount = s === '' ? null : rules.normalizeProfileInput({ warehouseCount: Number(s) }).warehouseCount;
  }
  if (has('salesChannels')) {
    const parts = String(r.salesChannels || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    const keys = parts.map(p => CHANNEL_BY_LABEL[p.normalize('NFC').toLowerCase()] || (rules.SALES_CHANNELS.includes(p) ? p : null));
    if (keys.includes(null)) throw rules.httpError(400, 'INVALID_PROFILE', `Hình thức bán hàng không hợp lệ: ${parts[keys.indexOf(null)]}.`);
    v.salesChannels = rules.SALES_CHANNELS.filter(c => keys.includes(c));
  }
  if (has('warehouseScale')) {
    const s = String(r.warehouseScale || '').normalize('NFC').trim().toLowerCase();
    if (!s) v.warehouseScale = 'none';
    else if (SCALE_BY_LABEL[s]) v.warehouseScale = SCALE_BY_LABEL[s];
    else if (rules.SCALES.includes(s)) v.warehouseScale = s;
    else throw rules.httpError(400, 'INVALID_PROFILE', `Quy mô khách không hợp lệ: ${r.warehouseScale}.`);
  }
  return v;
}

const isBlank = (f, val) => (f === 'warehouseCount' ? val == null : f === 'salesChannels' ? !val || !val.length : f === 'warehouseScale' ? !val || val === 'none' : !val);
const same = (f, a, b) => (f === 'salesChannels' ? JSON.stringify(a || []) === JSON.stringify(b || []) : (a == null ? '' : a) === (b == null ? '' : b));
const display = (f, val) => (f === 'salesChannels' ? (val || []).map(c => CHANNEL_LABELS[c] || c).join(', ') : f === 'warehouseScale' ? SCALE_LABELS[val || 'none'] : val == null ? '' : String(val));

// existing: Map key -> ho so hien co {phone,address,...}; khach chua co ho so coi nhu rong.
// Tra { changes: [{key,name,values,fields:[{field,from,to}]}], invalid, unmatched, duplicates, unchanged }.
function plan({ rows, columns, validKeys, existing, mode = 'fill' }) {
  const byKey = new Map(), invalid = [], unmatched = [];
  let duplicates = 0;
  for (const r of rows) {
    const key = nameKey(r.name);
    if (!key) continue;
    if (!validKeys.has(key)) { unmatched.push(r.name); continue; }
    let values;
    try { values = normalizeRow(r, columns); } catch (e) { invalid.push({ row: r.rowNumber, name: r.name, reason: e.message }); continue; }
    if (byKey.has(key)) duplicates++;
    byKey.set(key, { key, name: r.name, values });
  }
  const changes = [];
  let unchanged = 0;
  for (const e of byKey.values()) {
    const cur = existing.get(e.key) || rules.emptyProfile();
    const fields = [];
    const values = {};
    for (const f of columns) {
      const next = e.values[f];
      if (isBlank(f, next)) continue; // trong = khong dong toi
      if (same(f, cur[f], next)) continue;
      if (mode === 'fill' && !isBlank(f, cur[f])) continue;
      values[f] = next;
      fields.push({ field: f, from: display(f, cur[f]), to: display(f, next) });
    }
    if (fields.length) changes.push({ key: e.key, name: e.name, values, fields }); else unchanged++;
  }
  return { changes, invalid, unmatched, duplicates, unchanged, matched: byKey.size };
}

async function loadExisting(pool, keys) {
  const map = new Map();
  for (let i = 0; i < keys.length; i += 2000) {
    const { rows } = await pool.query(
      `SELECT customer_key, phone, address, warehouse_location, warehouse_count, area, competitor, sales_channels, warehouse_scale
       FROM customer_profiles WHERE customer_key = ANY($1::text[])`, [keys.slice(i, i + 2000)]);
    for (const r of rows) {
      map.set(r.customer_key, {
        phone: r.phone || '', address: r.address || '', warehouseLocation: r.warehouse_location || '', area: r.area || '', competitor: r.competitor || '',
        warehouseCount: r.warehouse_count == null ? null : Number(r.warehouse_count), salesChannels: r.sales_channels || [], warehouseScale: r.warehouse_scale || 'none'
      });
    }
  }
  return map;
}

// Upsert theo tung cot, quyet dinh ngay trong SQL (khong ghi de gia tri vua duoc nguoi khac sua giua luc xem truoc va ap dung).
// Gia tri truyen vao: '' / NULL / '' / 'none' = khong dong toi cot do.
function upsertSql(mode) {
  const text = col => (mode === 'overwrite'
    ? `${col} = CASE WHEN EXCLUDED.${col} <> '' THEN EXCLUDED.${col} ELSE customer_profiles.${col} END`
    : `${col} = CASE WHEN customer_profiles.${col} = '' THEN EXCLUDED.${col} ELSE customer_profiles.${col} END`);
  const count = mode === 'overwrite' ? 'warehouse_count = COALESCE(EXCLUDED.warehouse_count, customer_profiles.warehouse_count)' : 'warehouse_count = COALESCE(customer_profiles.warehouse_count, EXCLUDED.warehouse_count)';
  const channels = mode === 'overwrite'
    ? 'sales_channels = CASE WHEN cardinality(EXCLUDED.sales_channels) > 0 THEN EXCLUDED.sales_channels ELSE customer_profiles.sales_channels END'
    : 'sales_channels = CASE WHEN cardinality(customer_profiles.sales_channels) = 0 THEN EXCLUDED.sales_channels ELSE customer_profiles.sales_channels END';
  const scale = mode === 'overwrite'
    ? "warehouse_scale = CASE WHEN EXCLUDED.warehouse_scale <> 'none' THEN EXCLUDED.warehouse_scale ELSE customer_profiles.warehouse_scale END"
    : "warehouse_scale = CASE WHEN customer_profiles.warehouse_scale = 'none' THEN EXCLUDED.warehouse_scale ELSE customer_profiles.warehouse_scale END";
  return `INSERT INTO customer_profiles (customer_key, customer_name, phone, address, warehouse_location, warehouse_count, area, competitor, sales_channels, warehouse_scale, updated_by_id, updated_by_name, updated_at)
    SELECT t.k, t.n, t.ph, t.ad, t.wl, t.wc, t.ar, t.cp, CASE WHEN t.ch = '' THEN '{}'::text[] ELSE string_to_array(t.ch, ',') END, t.sc, $11::text, $12::text, now()
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::text[], $9::text[], $10::text[]) AS t(k, n, ph, ad, wl, wc, ar, cp, ch, sc)
    ON CONFLICT (customer_key) DO UPDATE SET ${[text('phone'), text('address'), text('warehouse_location'), count, text('area'), text('competitor'), channels, scale].join(', ')},
      customer_name = CASE WHEN customer_profiles.customer_name = '' THEN EXCLUDED.customer_name ELSE customer_profiles.customer_name END,
      updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`;
}

async function writeChanges(pool, changes, mode, actor) {
  const sql = upsertSql(mode);
  let written = 0;
  for (let i = 0; i < changes.length; i += 300) {
    const part = changes.slice(i, i + 300);
    const col = (f, empty) => part.map(c => (c.values[f] === undefined ? empty : c.values[f]));
    await pool.query(sql, [
      part.map(c => c.key), part.map(c => c.name), col('phone', ''), col('address', ''), col('warehouseLocation', ''), col('warehouseCount', null),
      col('area', ''), col('competitor', ''), part.map(c => (c.values.salesChannels || []).join(',')), col('warehouseScale', 'none'),
      actor && actor.id != null ? String(actor.id) : null, String((actor && actor.name) || '')
    ]);
    written += part.length;
  }
  return written;
}

// rows/columns: ket qua parseWorksheet; validKeys: Set khoa khach trong bang bao cao; pool: pg pool.
async function runProfileImport({ rows, columns, validKeys, pool, apply = false, mode = 'fill', actor = null }) {
  if (mode !== 'fill' && mode !== 'overwrite') throw rules.httpError(400, 'INVALID_IMPORT_MODE', 'Chế độ import không hợp lệ.');
  const keys = [...new Set(rows.map(r => nameKey(r.name)).filter(k => validKeys.has(k)))];
  let existing;
  try { existing = await loadExisting(pool, keys); } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) throw rules.httpError(503, 'MIGRATION_PENDING', 'Chức năng thông tin khách chưa sẵn sàng (chưa cập nhật cơ sở dữ liệu).');
    throw e;
  }
  const p = plan({ rows, columns, validKeys, existing, mode });
  const fieldCounts = {};
  for (const c of p.changes) for (const f of c.fields) fieldCounts[FIELD_LABELS[f.field]] = (fieldCounts[FIELD_LABELS[f.field]] || 0) + 1;
  const summary = {
    mode: apply ? 'applied' : 'preview', importMode: mode, rows: rows.length, columns: columns.map(f => FIELD_LABELS[f]), matched: p.matched,
    wouldChange: p.changes.length, unchanged: p.unchanged, fieldCounts, duplicates: p.duplicates,
    invalidRows: p.invalid.length, invalidSample: p.invalid.slice(0, 20), unmatched: p.unmatched.length, unmatchedSample: p.unmatched.slice(0, 50),
    changesSample: p.changes.slice(0, MAX_SAMPLE).map(c => ({ name: c.name, fields: c.fields.map(f => ({ label: FIELD_LABELS[f.field], from: f.from, to: f.to })) }))
  };
  if (apply) summary.changed = await writeChanges(pool, p.changes, mode, actor);
  return summary;
}

module.exports = { parseWorksheet, readExcelUpload, normalizeRow, plan, runProfileImport, upsertSql, HEADER_FIELDS, FIELD_LABELS };
