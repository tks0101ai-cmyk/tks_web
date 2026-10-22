// ==========================================
// IMPORT ORDER VAT 1 — dua toan bo sheet "ORDER VAT 1" (Google Form cu) vao bang
// vat_requests (migration 0073) voi is_legacy = true.
//
//   node scripts/importOrderVat.js --file order-vat.csv            (mac dinh: chay thu, KHONG ghi)
//   node scripts/importOrderVat.js --sheet <id> --gid <gid>        (doc thang sheet cong khai)
//   node scripts/importOrderVat.js --file order-vat.csv --apply    (ghi that, 1 transaction)
//
// Cot A..L cua sheet: Thoi gian, Email, Ten Sale, Khach hang, Ma SP Trim, Ten SP, So luong,
// Gia chua VAT, Ghi chu, KT PHAN HOI, KT NOTE CHO SALE, NGAY VE. Cot M..R (Ten ma KT, Tong
// tien, Ton VAT, SLG can khai, Du kien) bo qua — web tu tinh live.
//   - Sale: khop email cot B voi tai khoan web; khong khop thi giu ten cot C lam chu.
//   - O "X" / trong / sai so -> NULL (dong cu duoc phep thieu). Full VAT = ghi chu co "FULL VAT".
//   - Thoi gian loi ('X') -> NULL (sheet da sap theo ma SP, khong suy duoc tu dong ben canh).
//   - O giu cho 'X', '....', '-' coi nhu trong.
//   - Idempotent theo so dong sheet (legacy_row): chay lai khong nhan doi.
//   - KT PHAN HOI: "3. Cho khai chen" (so dau) hoac chi chu "Cho khai chen" / "Da ve" (= 1 Da xong) /
//     "VAT san nhieu" (= 5, can migration 0083); chu la -> pending + bao trong report.
//
//   node scripts/importOrderVat.js --file moi.csv --replace --apply
//     Thay TOAN BO: cung 1 transaction, xoa mem moi yeu cau dang hien (is_deleted, bo legacy_row,
//     lich su 'delete') roi nhap file moi; thu tu = thoi gian tao moi nhat truoc (nhu migration 0079).
// ==========================================
'use strict';

const fs = require('node:fs');
const { parseCsv } = require('../vatDraft/csv');

const STATUS_RE = /^\s*([0-5])\s*[.)-]?/;
// Nhan chu khong co so dau (sheet doi ten "1. Da xong" -> "Da ve" tu 22/10/2026). Khoa = chu thuong, bo dau cau.
const STATUS_LABELS = new Map([
  ['không khai được', '0'],
  ['đã xong', '1'], ['đã về', '1'],
  ['đã khai chờ về', '2'],
  ['chờ khai chèn', '3'],
  ['chờ cont về tăng slg', '4'], ['chờ cont về', '4'],
  ['vat sẵn nhiều', '5']
]);

/** KT PHAN HOI -> ma trang thai; trong -> 'pending'; chu la -> null. */
function parseStatus(text) {
  const value = String(text || '').trim();
  if (!value) return 'pending';
  const numbered = STATUS_RE.exec(value);
  if (numbered) return numbered[1];
  const key = value.normalize('NFC').toLowerCase().replace(/[.,;:\-–]+/g, ' ').replace(/\s+/g, ' ').trim();
  return STATUS_LABELS.get(key) || null;
}
const FULL_VAT_RE = /full\s*vat/i;
const PLACEHOLDER_RE = /^[.\-xX\s]*$/;

function cell(row, index) {
  return String(row[index] ?? '').trim();
}

function parseVnNumber(text) {
  const cleaned = String(text || '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value > 0 ? value : null;
}

/** '19/10/2026' hoac '19/10/2026 14:22:01' (gio VN) -> ISO UTC; loi -> null. */
function parseVnTimestamp(text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text || '').trim());
  if (!match) return null;
  const [day, month, year, hour = 0, minute = 0, second = 0] = match.slice(1).map(v => Number(v || 0));
  const date = new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
  const check = new Date(date.getTime() + 7 * 3600 * 1000);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return date.toISOString();
}

function parseVnDate(text) {
  const iso = parseVnTimestamp(String(text || '').trim().split(/\s+/)[0]);
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * CSV records (dong 1 la tieu de) -> { rows, report }. `usersByEmail`: Map(email thuong -> { id, hoTen }).
 * Thuan tuy, khong cham DB — de test.
 */
function mapOrderVatRows(records, { usersByEmail = new Map() } = {}) {
  const report = { total: 0, skippedBlank: 0, mappedSale: 0, unmappedSale: 0, unmappedEmails: new Map(), badTime: 0, missingQuantity: 0, missingPrice: 0, missingProduct: 0, unknownStatus: 0, byStatus: {} };
  const rows = [];
  records.slice(1).forEach((record, index) => {
    const sheetRow = index + 2;
    const values = Array.from({ length: 12 }, (_, i) => cell(record, i));
    if (values.every(v => PLACEHOLDER_RE.test(v))) { report.skippedBlank += 1; return; }
    report.total += 1;

    const createdAt = parseVnTimestamp(values[0]);
    if (!createdAt) report.badTime += 1;

    const email = values[1].toLowerCase();
    const user = email && usersByEmail.get(email);
    if (user) report.mappedSale += 1;
    else {
      report.unmappedSale += 1;
      const key = email || `(trống) ${values[2]}`;
      report.unmappedEmails.set(key, (report.unmappedEmails.get(key) || 0) + 1);
    }

    const quantity = parseVnNumber(values[6]);
    const price = parseVnNumber(values[7]);
    if (quantity === null) report.missingQuantity += 1;
    if (price === null) report.missingPrice += 1;
    const productCode = PLACEHOLDER_RE.test(values[4]) ? '' : values[4];
    if (!productCode) report.missingProduct += 1;

    const parsedStatus = parseStatus(values[9]);
    if (!parsedStatus) report.unknownStatus += 1;
    const status = parsedStatus || 'pending';
    report.byStatus[status] = (report.byStatus[status] || 0) + 1;

    const clean = text => (PLACEHOLDER_RE.test(text) ? '' : text);
    rows.push({
      legacy_row: sheetRow,
      created_at: createdAt,
      created_by: user ? String(user.id) : null,
      created_by_name: user ? (user.hoTen || clean(values[2])) : clean(values[2]),
      created_by_email: values[1].includes('@') ? values[1] : '',
      is_legacy: true,
      customer_name: clean(values[3]),
      product_code: productCode,
      product_name: clean(values[5]),
      quantity,
      unit_price_excl_vat: price,
      full_vat: FULL_VAT_RE.test(values[8]) || FULL_VAT_RE.test(values[7]),
      sale_note: values[8],
      status,
      accountant_note: values[10],
      arrival_date: parseVnDate(values[11])
    });
  });
  return { rows, report };
}

/**
 * Ghi cac dong vao DB trong 1 transaction. `replace` = { label }: truoc khi nhap, xoa mem MOI yeu cau dang
 * hien (is_deleted, legacy_row = NULL de nhap lai dung so dong sheet, +1 version, lich su 'delete' ten `label`),
 * nhap xong dat sort_rank theo thoi gian tao (moi nhat truoc, dong thieu thoi gian xuong cuoi) nhu 0079.
 * Tra { inserted, removed }; khong replace thi tra so dong moi (giu cach goi cu).
 */
async function insertRows(pool, rows, { replace = null } = {}) {
  const client = await pool.connect();
  let inserted = 0;
  let removed = 0;
  const ids = [];
  try {
    await client.query('BEGIN');
    if (replace) {
      const gone = await client.query(
        `WITH gone AS (
           UPDATE vat_requests SET is_deleted = true, legacy_row = NULL, version = version + 1, updated_at = now()
           WHERE NOT is_deleted RETURNING id
         )
         INSERT INTO vat_request_history (request_id, changed_at, changed_by_name, action)
         SELECT id, now(), $1, 'delete' FROM gone RETURNING request_id`,
        [replace.label]
      );
      removed = gone.rows.length;
    }
    for (const row of rows) {
      const columns = Object.keys(row);
      const { rows: result } = await client.query(
        `INSERT INTO vat_requests (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (legacy_row) WHERE legacy_row IS NOT NULL DO NOTHING RETURNING id`,
        columns.map(column => row[column])
      );
      if (!result.length) continue;
      inserted += 1;
      ids.push(result[0].id);
      await client.query(
        `INSERT INTO vat_request_history (request_id, changed_at, changed_by_name, action, new_value)
         VALUES ($1, now(), 'Nhập từ ORDER VAT 1', 'import', $2)`,
        [result[0].id, `Dòng ${row.legacy_row}`]
      );
    }
    if (replace && ids.length) {
      await client.query(
        `UPDATE vat_requests SET sort_rank = COALESCE(extract(epoch FROM created_at)::numeric * 1000, 0) + id * 0.000000001
         WHERE id = ANY($1::bigint[])`,
        [ids]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return replace ? { inserted, removed } : inserted;
}

function readArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply' || argv[i] === '--replace') {
      args[argv[i].slice(2)] = true;
    } else if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function printReport(report) {
  console.log(`Dòng dữ liệu: ${report.total} (bỏ ${report.skippedBlank} dòng trống)`);
  console.log(`Sale khớp tài khoản: ${report.mappedSale} · không khớp (giữ tên chữ): ${report.unmappedSale}`);
  console.log(`Thời gian lỗi (để trống): ${report.badTime} · thiếu SL: ${report.missingQuantity} · thiếu giá: ${report.missingPrice} · thiếu mã SP: ${report.missingProduct}`);
  console.log(`Trạng thái: ${JSON.stringify(report.byStatus)} · KT phản hồi lạ (về pending): ${report.unknownStatus}`);
  if (report.unmappedEmails.size) {
    console.log('Email chưa có tài khoản web:');
    [...report.unmappedEmails.entries()].sort((a, b) => b[1] - a[1]).forEach(([email, count]) => console.log(`  ${email}: ${count} dòng`));
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  let csv;
  if (args.file) csv = fs.readFileSync(args.file, 'utf8');
  else if (args.sheet && args.gid) {
    const { fetchSheetCsv } = require('../vatDraft/sheetsSource');
    csv = await fetchSheetCsv({ sheetId: args.sheet, gid: args.gid, sheetName: 'ORDER VAT 1' });
  } else {
    console.error('Cần --file <csv> hoặc --sheet <id> --gid <gid>. Thêm --apply để ghi thật.');
    process.exit(1);
  }
  const localUserStore = require('../auth/localUserStore');
  const usersByEmail = new Map();
  for (const user of await localUserStore.getAllUsers()) {
    if (user.isDeleted) continue;
    for (const email of [user.email, user.emailKhoiPhuc]) {
      if (email) usersByEmail.set(String(email).trim().toLowerCase(), user);
    }
  }
  const { rows, report } = mapOrderVatRows(parseCsv(csv), { usersByEmail });
  printReport(report);
  if (!args.apply) {
    console.log(`\nChạy thử — chưa ghi gì. Thêm --apply để ${args.replace ? 'xóa mềm toàn bộ yêu cầu đang hiện rồi nhập file này' : 'nhập thật'}.`);
    return;
  }
  const { getPool } = require('../db/pool');
  if (args.replace) {
    const day = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
    const { inserted, removed } = await insertRows(getPool(), rows, { replace: { label: `Thay bằng bản xuất ORDER VAT 1 (${day})` } });
    console.log(`\nĐã xóa mềm ${removed} yêu cầu cũ và nhập ${inserted} dòng từ file mới.`);
    return;
  }
  const inserted = await insertRows(getPool(), rows);
  console.log(`\nĐã nhập ${inserted} dòng mới (${rows.length - inserted} dòng đã có từ lần trước).`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    console.error('Import thất bại:', error.message);
    process.exit(1);
  });
}

module.exports = { mapOrderVatRows, insertRows, parseStatus, parseVnTimestamp, parseVnDate, parseVnNumber };
