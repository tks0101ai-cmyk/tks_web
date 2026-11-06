'use strict';
// Nap ban chup nguon TKS (JSON {conts,rows}) vao bang Thu mua canonical.
//
// Khac seedSampleData.js: day la DU LIEU NGHIEP VU THAT, dung dai khoa chinh thuc
// D00001+ nen KHONG co dau de go rieng. Vi vay script chi chay khi purchase_orders
// dang rong, tru khi truyen --replace (xoa sach roi nap lai).
//
// Khong di qua API: khong dat purchase.operation_id nen khong sinh purchase_history
// bat bien — van nap lai duoc neu ban chup sai.
// Khong doi purchase_settings.source_mode. Doi nguon ghi la buoc rieng sau khi
// doi chieu xong (READINESS muc 39, cong cu purchaseOrdersReconcile.js).
const fs = require('node:fs');
const { getPool } = require('../db/pool');
// Dung CHINH XAC phep chuan hoa ten cont cua service: neu khac, cung mot ten cont
// se sinh hai name_key va UNIQUE(name_key) khong con chan trung ten tren web.
const { normalizeName } = require('./containerNames');

// Sheet dung ten cont gia "CONT CHO XEP" cho hang chua xep. Quyet dinh thiet ke:
// tren web do la container_id NULL, khong tao cont gia.
const QUEUE_NAME = /CHỜ XẾP/i;
// Trang thai cont o nguon la chuoi "<so>.<nhan>" — chu so dau chinh la trang thai.
const statusOf = text => {
  const m = /^\s*([1-4])\s*\./.exec(String(text || ''));
  return m ? Number(m[1]) : 1;
};

/** "24/09" -> Date(2026-09-24). Thieu nam thi suy theo `year`. O co hai ngay
 *  dinh nhau ("28/10+29/10") lay ngay DAU va ghi lai de bao cao. */
function parseListedAt(raw, year, anomalies, rowKey) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const parts = text.split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) anomalies.push({ rowKey, raw: text, taken: parts[0] });
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{4}))?$/.exec(parts[0]);
  if (!m) { anomalies.push({ rowKey, raw: text, taken: null }); return null; }
  const [, d, mo, y] = m;
  const day = Number(d), month = Number(mo), fullYear = Number(y || year);
  // Date.UTC tu cuon ngay khong ton tai (31/02 -> 03/03). Ban chup phai bao loi
  // thay vi am tham doi ngay, nen kiem lai tung thanh phan sau khi dung.
  const value = new Date(Date.UTC(fullYear, month - 1, day));
  if (value.getUTCFullYear() !== fullYear || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    anomalies.push({ rowKey, raw: text, taken: null, reason: 'NGAY_KHONG_TON_TAI' });
    return null;
  }
  return value;
}

const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const text = v => { const s = String(v == null ? '' : v).trim(); return s || null; };

async function importSourceRows({ pool = getPool(), file, year = 2026, replace = false, dryRun = false, logger = console } = {}) {
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = source.rows || [];
  const conts = (source.conts || []).filter(c => !QUEUE_NAME.test(c.name));
  const anomalies = [];
  const prepared = rows.map(r => ({
    rowKey: String(r.rowKey),
    // Ten sheet goc va so dong o ban nguon. Ban chup cu khong co hai truong nay
    // thi de null — dong nap truoc migration 0118 cung dang la null.
    sourceSheet: text(r.sheet ?? r.sourceSheet),
    sourceRow: Number.isSafeInteger(Number(r.row ?? r.sourceRow)) ? Number(r.row ?? r.sourceRow) : null,
    cont: QUEUE_NAME.test(r.cont || '') ? null : text(r.cont),
    listedAt: parseListedAt(r.listedAt, year, anomalies, String(r.rowKey)),
    productCode: text(r.code), productName: text(r.name), productNameCn: text(r.nameCn),
    supplier: text(r.supplier), buyer: text(r.buyer),
    qtyPerCarton: num(r.qtyPerCarton), cartonCount: num(r.cartonCount),
    unitPriceCny: num(r.unitPriceCny), freightPrepaid: num(r.freightPrepaid),
    fxRate: num(r.fxRate), freightPostpaid: num(r.freightPostpaid),
    kgPerCarton: num(r.kgPerCarton), m3PerCarton: num(r.m3PerCarton)
  }));

  const invalid = prepared.filter(r => !(r.qtyPerCarton > 0) || !(r.cartonCount > 0) || !r.productCode || !r.productName);
  // (sheet, dong) trung trong CUNG file: index 0118 se chan o DB, nhung bao som
  // thi nguoi dung sua ban chup chu khong phai doc loi Postgres.
  const seen = new Map(), dupSource = [];
  for (const r of prepared) {
    if (!r.sourceSheet || r.sourceRow == null) continue;
    const key = r.sourceSheet + '#' + r.sourceRow;
    if (seen.has(key)) dupSource.push(`${key} (${seen.get(key)} va ${r.rowKey})`); else seen.set(key, r.rowKey);
  }
  if (dupSource.length) {
    throw Object.assign(new Error(`${dupSource.length} vi tri nguon bi lap trong file: ` + dupSource.slice(0, 5).join('; ')),
      { code: 'SOURCE_POSITION_DUPLICATE', duplicates: dupSource });
  }
  const bySheet = {};
  for (const r of prepared) { const key = r.sourceSheet || '(khong ro nguon)'; bySheet[key] = (bySheet[key] || 0) + 1; }
  const summary = {
    rows: prepared.length, containers: conts.length, bySheet,
    queued: prepared.filter(r => !r.cont).length,
    invalid: invalid.length, anomalies
  };
  if (invalid.length) {
    throw Object.assign(new Error(`${invalid.length} dong khong hop le (thieu ma/ten hoac so thung/SL khong duong): ` +
      invalid.slice(0, 5).map(r => r.rowKey).join(', ')), { code: 'SOURCE_ROWS_INVALID', summary });
  }
  if (dryRun) { logger.log('[Purchase] CHAY THU — khong ghi gi'); return summary; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [20531015]);
    const mode = await client.query('SELECT source_mode FROM purchase_settings WHERE id=1');
    if (mode.rows[0] && mode.rows[0].source_mode === 'web') {
      throw Object.assign(new Error('Nguon ghi dang la web — nap ban chup luc nay se de len du lieu dang dung. Dung lai.'), { code: 'PURCHASE_SOURCE_IS_WEB' });
    }
    const existing = Number((await client.query('SELECT count(*)::int n FROM purchase_orders')).rows[0].n);
    if (existing && !replace) {
      throw Object.assign(new Error(`purchase_orders dang co ${existing} dong. Dung --replace neu muon xoa sach roi nap lai.`), { code: 'PURCHASE_NOT_EMPTY' });
    }
    if (existing) { await client.query('DELETE FROM purchase_orders'); await client.query('DELETE FROM product_containers'); }

    // Cont da co tren DB co the mang name_key cu (lower(btrim)) tu cac lan nap
    // truoc. Doi chieu theo TEN da chuan hoa de dung lai dung cont do, khong tao
    // ban trung, va khong viet lai name_key cua dong khong thuoc ban chup.
    const ids = new Map();
    const existingConts = new Map();
    const ambiguous = [];
    for (const row of (await client.query('SELECT id,name,name_key FROM product_containers ORDER BY id')).rows) {
      const key = normalizeName(row.name);
      const prior = existingConts.get(key);
      // Hai cont cu cung chuan hoa ve mot ten: khong tu gop (hai cont co the dang
      // giu dong khac nhau). Bao de nguoi dung xu ly trước khi nap.
      if (prior) { ambiguous.push({ key, ids: [prior.id, row.id], names: [prior.name, row.name] }); continue; }
      existingConts.set(key, row);
    }
    if (ambiguous.length) {
      throw Object.assign(new Error('Cont tren DB co ten tuong duong nhau sau chuan hoa, phai gop/doi ten truoc khi nap: ' +
        ambiguous.map(a => a.names.join(' = ')).join('; ')), { code: 'CONTAINER_NAME_AMBIGUOUS', ambiguous });
    }
    for (const c of conts) {
      const key = normalizeName(c.name);
      const prior = existingConts.get(key);
      if (prior) {
        await client.query('UPDATE product_containers SET status=$2,name_key=$3 WHERE id=$1', [prior.id, statusOf(c.status), key]);
        ids.set(c.name, prior.id);
        continue;
      }
      const { rows: out } = await client.query(
        `INSERT INTO product_containers(name,name_key,status) VALUES($1,$2,$3)
         ON CONFLICT(name_key) DO UPDATE SET status=EXCLUDED.status RETURNING id`,
        [c.name, key, statusOf(c.status)]
      );
      ids.set(c.name, out[0].id);
      existingConts.set(key, { id: out[0].id, name: c.name, name_key: key });
    }
    let inserted = 0;
    for (const r of prepared) {
      const res = await client.query(
        `INSERT INTO purchase_orders(row_key,root_key,container_id,product_code,product_name,product_name_cn,
           supplier,buyer,listed_at,qty_per_carton,carton_count,unit_price_cny,freight_prepaid,fx_rate,
           freight_postpaid,kg_per_carton,m3_per_carton,source_sheet,source_row)
         VALUES($1,split_part($1,'.',1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT(row_key) DO NOTHING`,
        [r.rowKey, r.cont ? ids.get(r.cont) : null, r.productCode, r.productName, r.productNameCn,
          r.supplier, r.buyer, r.listedAt, r.qtyPerCarton, r.cartonCount, r.unitPriceCny,
          r.freightPrepaid, r.fxRate, r.freightPostpaid, r.kgPerCarton, r.m3PerCarton,
          r.sourceSheet, r.sourceRow]
      );
      inserted += res.rowCount;
    }
    // Ban chup dung dai khoa chinh thuc D00001+ nhung khong di qua nextval, nen
    // sequence van o 0: khoa cap tiep theo (reserveKey/newKey) se trung ngay dong
    // dau. Day sequence len qua khoa goc lon nhat dang co, khong bao gio keo lui.
    const keySeq = (await client.query(
      `SELECT setval('purchase_order_key_seq', GREATEST(
         (SELECT last_value FROM purchase_order_key_seq),
         COALESCE((SELECT max(NULLIF(regexp_replace(split_part(row_key,'.',1),'^D','') ,'')::bigint) FROM purchase_orders),0)
       ))::bigint AS value`
    )).rows[0].value;
    await client.query('COMMIT');
    logger.log(`[Purchase] Da nap ${inserted}/${prepared.length} dong, ${conts.length} cont, ${summary.queued} dong cho xep; purchase_order_key_seq = ${keySeq}`);
    return Object.assign(summary, { inserted, keySeq: Number(keySeq) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importSourceRows, parseListedAt, statusOf, QUEUE_NAME };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('Dung: node purchaseOrders/importSourceRows.js <file.json> [--replace] [--dry-run] [--year=2026]'); process.exit(1); }
  const yearArg = args.find(a => a.startsWith('--year='));
  const pool = getPool();
  importSourceRows({
    pool, file, replace: args.includes('--replace'), dryRun: args.includes('--dry-run'),
    year: yearArg ? Number(yearArg.split('=')[1]) : 2026
  })
    .then(s => { console.log(JSON.stringify(s, null, 1)); return pool.end(); })
    .catch(error => { console.error('[Purchase] ' + (error.code || '') + ' ' + error.message); pool.end(); process.exitCode = 1; });
}
