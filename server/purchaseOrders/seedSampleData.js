'use strict';
// Nap du lieu MAU cho trang Thu mua de xem giao dien khi chua co ban nguon that.
//
// Vi sao can danh dau rieng: buoc doi chieu truoc cutover (READINESS muc 39) so
// tung cont giua snapshot Sheet va ban web. Dong mau khong duoc lan vao do, nen
// toan bo dong mau dung dai khoa D90001-D99999 va cont co ten bat dau "MAU —".
// Go bang --remove la sach, khong con dau vet.
//
// Khong di qua API: ham nay KHONG dat purchase.operation_id, nen trigger
// purchase_capture_row thoat som va khong sinh ban ghi purchase_operation_rows /
// purchase_history. Day la ly do go lai duoc — audit cua Thu mua la bat bien
// (purchase_immutable_guard chan UPDATE/DELETE), seed qua API se khong xoa duoc.
//
// Khong doi purchase_settings.source_mode. Nguon ghi van la Sheets.
const { getPool } = require('../db/pool');

const KEY_MIN = 'D90001';
const KEY_MAX = 'D99999';
const CONTAINER_PREFIX = 'MẪU — ';

// Bon cont phu cac truong hop dang xem: cuoc tu tinh, cuoc nhap tay, da ve,
// va hang chua xep cont (container_id NULL, khong can dong cont nao).
const CONTAINERS = Object.freeze([
  { key: 'a', name: CONTAINER_PREFIX + 'Cont 01', status: 2, truck: 'Xe 17.5', freightMode: 'formula', freight: null, carrier: 'BAT+A SỰ', loader: 'Anh Dũng' },
  { key: 'b', name: CONTAINER_PREFIX + 'Cont 02', status: 3, truck: 'Xe 18.5', freightMode: 'manual', freight: 185000000, carrier: 'TÂN PHÁT', loader: 'Anh Hùng' },
  { key: 'c', name: CONTAINER_PREFIX + 'Cont 03 (đã về)', status: 4, truck: 'Xe 17.5', freightMode: 'formula', freight: null, carrier: 'BAT+A SỰ', loader: 'Anh Dũng' },
]);

// Dong mau: du so do -> tinh duoc het chi so; thieu so do -> hien canh bao;
// tach cha/con .01/.02 -> xem lien he goc; container null -> Cont cho xep.
const ROWS = Object.freeze([
  { rowKey: 'D90001', cont: 'a', code: 'AC305', name: 'Băng dính trong 5cm', supplier: 'NCC Quảng Châu', qtyPerCarton: 100, cartonCount: 40, unitPriceCny: 1.85, fxRate: 3650, kgPerCarton: 12.5, m3PerCarton: 0.052 },
  { rowKey: 'D90002', cont: 'a', code: 'AC312', name: 'Băng dính đục 5cm', supplier: 'NCC Quảng Châu', qtyPerCarton: 100, cartonCount: 25, unitPriceCny: 1.95, fxRate: 3650, kgPerCarton: 12.8, m3PerCarton: 0.052 },
  { rowKey: 'D90003', cont: 'a', code: 'KE220', name: 'Kệ nhựa 3 tầng', supplier: 'NCC Nghĩa Ô', qtyPerCarton: 4, cartonCount: 60, unitPriceCny: 28.5, fxRate: 3650, kgPerCarton: 9.2, m3PerCarton: 0.18 },
  // Thieu kg/m3: cac o suy ra de trong va bang hien canh bao thieu so do.
  { rowKey: 'D90004', cont: 'a', code: 'KE221', name: 'Kệ nhựa 4 tầng', supplier: 'NCC Nghĩa Ô', qtyPerCarton: 4, cartonCount: 30, unitPriceCny: 34, fxRate: 3650, kgPerCarton: null, m3PerCarton: null },
  { rowKey: 'D90005', cont: 'b', code: 'CH118', name: 'Chậu rửa inox', supplier: 'NCC Phật Sơn', qtyPerCarton: 6, cartonCount: 50, unitPriceCny: 42, fxRate: 3650, kgPerCarton: 21, m3PerCarton: 0.21 },
  // Tach mã: cha D90006 giu phan con lai, hai nhanh .01/.02.
  { rowKey: 'D90006', cont: 'b', code: 'CH120', name: 'Chậu rửa inox đôi', supplier: 'NCC Phật Sơn', qtyPerCarton: 4, cartonCount: 20, unitPriceCny: 68, fxRate: 3650, kgPerCarton: 26, m3PerCarton: 0.3 },
  { rowKey: 'D90006.01', cont: 'b', splitFrom: 'D90006', code: 'CH120', name: 'Chậu rửa inox đôi', supplier: 'NCC Phật Sơn', qtyPerCarton: 4, cartonCount: 8, unitPriceCny: 68, fxRate: 3650, kgPerCarton: 26, m3PerCarton: 0.3 },
  { rowKey: 'D90006.02', cont: 'c', splitFrom: 'D90006', code: 'CH120', name: 'Chậu rửa inox đôi', supplier: 'NCC Phật Sơn', qtyPerCarton: 4, cartonCount: 12, unitPriceCny: 68, fxRate: 3650, kgPerCarton: 26, m3PerCarton: 0.3 },
  { rowKey: 'D90007', cont: 'c', code: 'NO450', name: 'Nồi inox 24cm', supplier: 'NCC Triều Châu', qtyPerCarton: 8, cartonCount: 45, unitPriceCny: 19.5, fxRate: 3650, kgPerCarton: 15.6, m3PerCarton: 0.095 },
  { rowKey: 'D90008', cont: 'c', code: 'NO452', name: 'Nồi inox 28cm', supplier: 'NCC Triều Châu', qtyPerCarton: 6, cartonCount: 35, unitPriceCny: 24, fxRate: 3650, kgPerCarton: 16.4, m3PerCarton: 0.11 },
  // Chua xep cont: container_id NULL -> hang doi "Cont cho xep".
  { rowKey: 'D90009', cont: null, code: 'TH808', name: 'Thùng nhựa 60L', supplier: 'NCC Nghĩa Ô', qtyPerCarton: 2, cartonCount: 80, unitPriceCny: 31, fxRate: 3650, kgPerCarton: 7.4, m3PerCarton: 0.24 },
  { rowKey: 'D90010', cont: null, code: 'TH810', name: 'Thùng nhựa 80L', supplier: 'NCC Nghĩa Ô', qtyPerCarton: 2, cartonCount: 55, unitPriceCny: 38, fxRate: 3650, kgPerCarton: 8.9, m3PerCarton: 0.3 },
]);

async function seedSampleData({ pool = getPool(), logger = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    // Cung advisory lock voi ghi cont va job Sheet: khong chen giua mot luot ghi that.
    await client.query('SELECT pg_advisory_xact_lock($1)', [20531015]);
    // Chot cach ly: chi nap khi nguon ghi con la Sheets. Luc do productContainers
    // sync.js va expectedRefresh.js deu bo qua bang Thu mua (cong source_mode==='web'),
    // nen dong mau khong the chay sang product_container_lines / _expected / _sync —
    // read model dung chung cua "Du kien hang ve" va "Vong doi don hang".
    // Neu da cutover sang web thi dung lai: dong mau se lan vao cac module do.
    const mode = await client.query('SELECT source_mode FROM purchase_settings WHERE id=1');
    if (mode.rows[0] && mode.rows[0].source_mode === 'web') {
      throw Object.assign(new Error('Nguon ghi dang la web: du lieu mau se lan sang read model dung chung. Khong nap.'), { code: 'PURCHASE_SOURCE_IS_WEB' });
    }
    const ids = new Map();
    for (const c of CONTAINERS) {
      const { rows } = await client.query(
        `INSERT INTO product_containers(name,name_key,status,truck_name,freight,carrier,loader,freight_mode)
         VALUES($1,lower(btrim($1)),$2,$3,$4,$5,$6,$7)
         ON CONFLICT(name_key) DO UPDATE SET status=EXCLUDED.status RETURNING id`,
        [c.name, c.status, c.truck, c.freight, c.carrier, c.loader, c.freightMode]
      );
      ids.set(c.key, rows[0].id);
    }
    let inserted = 0;
    for (const r of ROWS) {
      const result = await client.query(
        `INSERT INTO purchase_orders(row_key,root_key,split_from_key,container_id,product_code,product_name,
           supplier,qty_per_carton,carton_count,unit_price_cny,fx_rate,kg_per_carton,m3_per_carton,listed_at)
         VALUES($1,split_part($1,'.',1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT(row_key) DO NOTHING`,
        [r.rowKey, r.splitFrom || null, r.cont ? ids.get(r.cont) : null, r.code, r.name,
          r.supplier, r.qtyPerCarton, r.cartonCount, r.unitPriceCny, r.fxRate, r.kgPerCarton, r.m3PerCarton]
      );
      inserted += result.rowCount;
    }
    await client.query('COMMIT');
    logger.log(`[Purchase] Da nap ${inserted} dong mau / ${ROWS.length}, ${CONTAINERS.length} cont mau`);
    return { containers: CONTAINERS.length, rows: inserted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function removeSampleData({ pool = getPool(), logger = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [20531015]);
    const orders = await client.query(
      'DELETE FROM purchase_orders WHERE split_part(row_key,$1,1) BETWEEN $2 AND $3',
      ['.', KEY_MIN, KEY_MAX]
    );
    const containers = await client.query(
      'DELETE FROM product_containers WHERE name LIKE $1',
      [CONTAINER_PREFIX + '%']
    );
    await client.query('COMMIT');
    logger.log(`[Purchase] Da go ${orders.rowCount} dong mau va ${containers.rowCount} cont mau`);
    return { rows: orders.rowCount, containers: containers.rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { seedSampleData, removeSampleData, CONTAINERS, ROWS, KEY_MIN, KEY_MAX, CONTAINER_PREFIX };

if (require.main === module) {
  const pool = getPool();
  const run = process.argv.includes('--remove') ? removeSampleData : seedSampleData;
  run({ pool })
    .then(() => pool.end())
    .catch(error => { console.error('[Purchase] ' + (error.message || error.code)); pool.end(); process.exitCode = 1; });
}
