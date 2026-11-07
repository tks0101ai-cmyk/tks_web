'use strict';

// Bang "Gia duyet" (tab Hoa don, migration 0091): CRUD + goi y khach / san pham + tinh lai Kiem tra gia ban.
//
// Khach / san pham luu bang id Kiot (co so, id); ten + ma LUON JOIN customers / products luc doc -> Kiot doi ten thi bang
// tu cap nhat. Ghi (tao / sua / xoa) chay trong 1 giao dich: kiem tra ton tai -> ghi -> nhat ky bat bien -> tinh lai
// cac dong Kiem tra gia ban lien quan (SAVEPOINT: tinh lai loi thi VAN luu gia duyet, tra recalc.status = 'failed').

const { getPool } = require('../db/pool');
const fuzzy = require('../shared/fuzzySearch');
const { recalcWindow, SOURCE_NOT_READY } = require('./priceAuditRepository');
const { LOCK_KEY } = require('./priceAuditRefresh');
const { BRANCH_LABELS, bad } = require('./approvedPriceRules');
const { validateRow } = require('./approvedPriceImport');

const MAX_EXPORT_ROWS = 20000;
const SUGGEST_LIMIT = 20;
const SUGGEST_TTL_MS = 60 * 1000;

const ACTIVE_CUSTOMER_SQL = "COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false'";

const SELECT_SQL = `
  SELECT p.id::text AS id, p.branch, p.customer_id::text AS customer_id, p.product_id::text AS product_id,
         p.price_no_vat::text AS price_no_vat, p.price_with_vat::text AS price_with_vat, p.approver, p.approved_on::text AS approved_on, p.version,
         p.created_by, p.updated_by, p.updated_at,
         c.id IS NULL AS customer_missing, COALESCE(c.name, '') AS customer_name, COALESCE(c.code, '') AS customer_code,
         COALESCE(pr.code, '') AS product_code, COALESCE(pr.name, '') AS product_name
  FROM invoice_approved_prices p
  LEFT JOIN customers c ON c.branch = p.branch AND c.id = p.customer_id
  LEFT JOIN products pr ON pr.branch = p.branch AND pr.id = p.product_id`;

const WHERE_SQL = `
  WHERE ($1::text IS NULL OR p.approver = $1)
    AND ($2::date IS NULL OR p.approved_on >= $2::date)
    AND ($3::date IS NULL OR p.approved_on <= $3::date)`;

// Khoa cot (approvedPriceRules.SORT_KEYS) -> bieu thuc SQL; la hang so, khong bao gio la chuoi nguoi dung.
const SORT_SQL = Object.freeze({
  customerName: "lower(COALESCE(c.name, ''))", branch: 'p.branch', productCode: "lower(COALESCE(pr.code, ''))",
  productName: "lower(COALESCE(pr.name, ''))", priceNoVat: 'p.price_no_vat', priceWithVat: 'p.price_with_vat', approver: 'p.approver',
  approvedOn: 'p.approved_on'
});

function orderSql(sort, dir, sorts = []) {
  if (sorts.length) return `ORDER BY ${require('../shared/multiSort').orderBy(sorts, SORT_SQL)}, p.approved_on DESC, p.id DESC`;
  const expr = Object.prototype.hasOwnProperty.call(SORT_SQL, sort) ? SORT_SQL[sort] : null;
  const tie = 'p.approved_on DESC, p.id DESC';
  return expr ? `ORDER BY ${expr} ${dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${tie}` : `ORDER BY ${tie}`;
}

function mapRow(r) {
  return {
    id: r.id, branch: r.branch, branchLabel: BRANCH_LABELS[r.branch] || r.branch,
    customerId: r.customer_id, customerName: r.customer_name, customerCode: r.customer_code,
    customerMissing: Boolean(r.customer_missing),
    productId: r.product_id, productCode: r.product_code, productName: r.product_name,
    priceNoVat: r.price_no_vat, priceWithVat: r.price_with_vat, approver: r.approver, approvedOn: r.approved_on,
    version: Number(r.version), createdBy: r.created_by, updatedBy: r.updated_by,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null
  };
}

// Nhat ky luon camelCase; nhan dong DB (snake_case) hoac dau vao da kiem tra (camelCase).
const priceText = v => (v === null || v === undefined ? null : String(v));
const snapshot = row => row && ({ branch: row.branch, customerId: String(row.customerId ?? row.customer_id),
  productId: String(row.productId ?? row.product_id), priceNoVat: priceText(row.priceNoVat ?? row.price_no_vat), priceWithVat: priceText(row.priceWithVat ?? row.price_with_vat),
  approver: row.approver, approvedOn: row.approvedOn ?? row.approved_on, version: Number(row.version) });

const CUSTOMER_EXISTS_SQL = `SELECT 1 FROM customers c WHERE c.branch = $1 AND c.id = $2::bigint AND ${ACTIVE_CUSTOMER_SQL}`;
const PRODUCT_EXISTS_SQL = 'SELECT 1 FROM products WHERE branch = $1 AND id = $2::bigint AND COALESCE(is_active, TRUE)';
const LOCK_SQL = 'SELECT id::text AS id, branch, customer_id::text AS customer_id, product_id::text AS product_id, price_no_vat::text AS price_no_vat, price_with_vat::text AS price_with_vat, approver, approved_on::text AS approved_on, version FROM invoice_approved_prices WHERE id = $1::bigint FOR UPDATE';
const INSERT_SQL = `INSERT INTO invoice_approved_prices
  (branch, customer_id, product_id, price_no_vat, price_with_vat, approver, approved_on, created_by, updated_by)
  VALUES ($1, $2::bigint, $3::bigint, $4::numeric, $5::numeric, $6, $7::date, $8, $8) RETURNING id::text AS id`;
const UPDATE_SQL = `UPDATE invoice_approved_prices
  SET branch = $2, customer_id = $3::bigint, product_id = $4::bigint, price_no_vat = $5::numeric, price_with_vat = $6::numeric, approver = $7,
      approved_on = $8::date, version = version + 1, updated_by = $9, updated_at = now()
  WHERE id = $1::bigint AND version = $10 RETURNING version`;
const DELETE_SQL = 'DELETE FROM invoice_approved_prices WHERE id = $1::bigint';
const CHANGE_SQL = `INSERT INTO invoice_approved_price_changes (price_id, action, actor, before_value, after_value)
  VALUES ($1::bigint, $2, $3, $4::jsonb, $5::jsonb)`;
const STATE_SQL = 'SELECT published_day::text AS published_day FROM invoice_price_audit_state WHERE id';

// Import (xem importPrices): doi chieu ma KH / ma SP trong file voi KiotViet cua co so (khong phan biet hoa/thuong), roi tim
// ban ghi da co cung (co so, khach, SP, ngay duyet) de ghi de.
const IMPORT_CUSTOMERS_SQL = `SELECT c.id::text AS id, lower(btrim(c.code)) AS code, c.name FROM customers c
  WHERE c.branch = $1 AND lower(btrim(c.code)) = ANY($2::text[]) AND ${ACTIVE_CUSTOMER_SQL}`;
const IMPORT_PRODUCTS_SQL = `SELECT id::text AS id, lower(btrim(code)) AS code, name FROM products
  WHERE branch = $1 AND lower(btrim(code)) = ANY($2::text[]) AND COALESCE(is_active, TRUE)`;
const importExistingSql = lock => `SELECT p.id::text AS id, p.branch, p.customer_id::text AS customer_id, p.product_id::text AS product_id,
  p.price_no_vat::text AS price_no_vat, p.price_with_vat::text AS price_with_vat, p.approver, p.approved_on::text AS approved_on, p.version
  FROM invoice_approved_prices p
  JOIN unnest($1::text[], $2::bigint[], $3::bigint[], $4::date[]) AS k(branch, customer_id, product_id, approved_on)
    ON p.branch = k.branch AND p.customer_id = k.customer_id AND p.product_id = k.product_id AND p.approved_on = k.approved_on
  ${lock ? 'FOR UPDATE OF p' : ''}`;

function conflict(row) {
  return Object.assign(bad('Bản ghi vừa được người khác cập nhật. Hãy tải lại rồi thử lại.', 'VERSION_CONFLICT', 409), row ? { row } : {});
}

// null (de trong) khac moi gia tri; so sanh so, khong so sanh chuoi (23000 = 23000.00).
const samePrice = (a, b) => (a === null || a === undefined ? b === null || b === undefined : b !== null && b !== undefined && Number(a) === Number(b));
const sameKey = (a, b) => a.branch === b.branch && String(a.customerId) === String(b.customerId)
  && String(a.productId) === String(b.productId);

/**
 * Tinh lai cac dong Kiem tra gia ban lien quan (trong giao dich cua nguoi goi, trong SAVEPOINT).
 * scopes: [{ branch, customerId, productId, fromDay }]. Tra { status: 'applied'|'skipped'|'not_published'|'busy'|'failed', ... }.
 */
async function applyRecalc(client, scopes, now) {
  if (!scopes.length) return { status: 'skipped' };
  await client.query('SAVEPOINT approved_price_recalc');
  try {
    const day = (await client.query(STATE_SQL)).rows[0]?.published_day;
    if (!day) {
      await client.query('RELEASE SAVEPOINT approved_price_recalc');
      return { status: 'not_published' };
    }
    // Cung khoa voi job 23:00 / --recalc: khong tinh lai chong len nhau; ban, gia duyet van luu va ap o lan chay sau.
    if (!(await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', [LOCK_KEY])).rows[0].ok) {
      await client.query('RELEASE SAVEPOINT approved_price_recalc');
      return { status: 'busy' };
    }
    // 1 lan cho moi pham vi (doc nguon 1 lan, khong lap theo tung pham vi).
    const { recomputedLines, resultChangedLines } = await recalcWindow({ day, client, now, scope: scopes });
    await client.query('RELEASE SAVEPOINT approved_price_recalc');
    return { status: 'applied', recomputedLines, resultChangedLines };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT approved_price_recalc');
    return { status: 'failed', message: err && err.code === SOURCE_NOT_READY ? err.message
      : 'Chưa tính lại được Kiểm tra giá bán; giá duyệt đã lưu và sẽ áp ở lượt chạy sau.' };
  }
}

function createApprovedPriceRepository({ pool = getPool(), now = () => new Date() } = {}) {
  async function list(query, { all = false } = {}) {
    const params = [query.approver, query.from, query.to];
    const order = orderSql(query.sort, query.dir, query.sorts);
    if (query.q) {
      const candidates = (await pool.query(`${SELECT_SQL} ${WHERE_SQL} ${order}`, params)).rows.map(mapRow);
      const matcher = fuzzy.createMatcher(query.q);
      const matched = candidates.filter(row => matcher.score(fuzzy.fold([
        row.customerName, row.customerCode, row.productCode, row.productName, row.approver
      ].join(' '))));
      const records = matched.length;
      const customers = new Set(matched.map(row => `${row.branch}:${row.customerId}`)).size;
      const products = new Set(matched.map(row => `${row.branch}:${row.productId}`)).size;
      const latest = matched.reduce((value, row) => !value || row.approvedOn > value ? row.approvedOn : value, null);
      const limit = all ? MAX_EXPORT_ROWS + 1 : query.pageSize;
      const offset = all ? 0 : (query.page - 1) * query.pageSize;
      return {
        rows: all ? matched.slice(0, limit) : matched.slice(offset, offset + limit), totalRows: records,
        page: all ? 1 : query.page, pageSize: all ? limit : query.pageSize,
        kpis: { records, customers, products, latestApprovedOn: latest }
      };
    }
    // Chi so theo CUNG bo loc voi bang (dem tren toan tap loc, khong chi trang hien tai).
    const k = (await pool.query(`SELECT count(*)::int AS n, count(DISTINCT (p.branch, p.customer_id))::int AS customers,
      count(DISTINCT (p.branch, p.product_id))::int AS products, max(p.approved_on)::text AS latest
      FROM invoice_approved_prices p ${WHERE_SQL}`, params)).rows[0];
    const limit = all ? MAX_EXPORT_ROWS + 1 : query.pageSize;
    const offset = all ? 0 : (query.page - 1) * query.pageSize;
    const rows = (await pool.query(`${SELECT_SQL} ${WHERE_SQL} ${order} LIMIT $4 OFFSET $5`, [...params, limit, offset])).rows;
    return {
      rows: rows.map(mapRow), totalRows: k.n, page: all ? 1 : query.page, pageSize: all ? limit : query.pageSize,
      kpis: { records: k.n, customers: k.customers, products: k.products, latestApprovedOn: k.latest }
    };
  }

  async function readOne(id, db = pool) {
    const r = (await db.query(`${SELECT_SQL} WHERE p.id = $1::bigint`, [id])).rows[0];
    return r ? mapRow(r) : null;
  }

  // Khach / san pham phai co that trong KiotViet cua co so do (khach ngung hoat dong khong duoc chon).
  async function assertTargets(client, input) {
    if (!(await client.query(CUSTOMER_EXISTS_SQL, [input.branch, input.customerId])).rows[0]) {
      throw bad('Khách hàng không có trong danh sách KiotViet của cơ sở này (hoặc đã ngừng hoạt động).', 'CUSTOMER_NOT_FOUND', 422);
    }
    if (!(await client.query(PRODUCT_EXISTS_SQL, [input.branch, input.productId])).rows[0]) {
      throw bad('Mã SP không có trong danh sách KiotViet của cơ sở này.', 'PRODUCT_NOT_FOUND', 422);
    }
  }

  async function inTransaction(fn) {
    const client = await pool.connect();
    let done = false;
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      done = true;
      return out;
    } catch (err) {
      if (err && err.code === '23505') {
        throw bad('Đã có giá duyệt cho khách, mã SP, cơ sở và ngày duyệt này. Hãy sửa bản ghi đó.', 'DUPLICATE', 409);
      }
      throw err;
    } finally {
      if (!done) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  async function create(input, actor) {
    return inTransaction(async client => {
      await assertTargets(client, input);
      const id = (await client.query(INSERT_SQL, [input.branch, input.customerId, input.productId, input.priceNoVat,
        input.priceWithVat, input.approver, input.approvedOn, actor])).rows[0].id;
      await client.query(CHANGE_SQL, [id, 'create', actor, null, JSON.stringify(snapshot({ ...input, version: 1 }))]);
      const recalc = await applyRecalc(client, [{ branch: input.branch, customerId: input.customerId,
        productId: input.productId, fromDay: input.approvedOn }], now());
      return { row: await readOne(id, client), recalc };
    });
  }

  async function update(id, input, actor) {
    return inTransaction(async client => {
      const before = (await client.query(LOCK_SQL, [id])).rows[0];
      if (!before) throw bad('Bản ghi giá duyệt không tồn tại (có thể đã bị xóa).', 'NOT_FOUND', 404);
      if (Number(before.version) !== input.expectedVersion) throw conflict(await readOne(id, client));
      await assertTargets(client, input);
      const updated = (await client.query(UPDATE_SQL, [id, input.branch, input.customerId, input.productId, input.priceNoVat,
        input.priceWithVat, input.approver, input.approvedOn, actor, input.expectedVersion])).rows[0];
      if (!updated) throw conflict(await readOne(id, client));
      const after = { ...input, version: Number(updated.version) };
      await client.query(CHANGE_SQL, [id, 'update', actor, JSON.stringify(snapshot(before)), JSON.stringify(snapshot(after))]);
      // Chi gia / ngay / khach / san pham / co so moi doi ket qua kiem tra gia; doi moi nguoi duyet thi khong can tinh lai.
      const oldKey = { branch: before.branch, customerId: before.customer_id, productId: before.product_id };
      const effectChanged = !sameKey(oldKey, input) || before.approved_on !== input.approvedOn
        || !samePrice(before.price_no_vat, input.priceNoVat) || !samePrice(before.price_with_vat, input.priceWithVat);
      const scopes = [];
      if (effectChanged) {
        if (sameKey(oldKey, input)) {
          scopes.push({ ...oldKey, fromDay: before.approved_on < input.approvedOn ? before.approved_on : input.approvedOn });
        } else {
          scopes.push({ ...oldKey, fromDay: before.approved_on },
            { branch: input.branch, customerId: input.customerId, productId: input.productId, fromDay: input.approvedOn });
        }
      }
      return { row: await readOne(id, client), recalc: await applyRecalc(client, scopes, now()) };
    });
  }

  async function remove(id, expectedVersion, actor) {
    return inTransaction(async client => {
      const before = (await client.query(LOCK_SQL, [id])).rows[0];
      if (!before) throw bad('Bản ghi giá duyệt không tồn tại (có thể đã bị xóa).', 'NOT_FOUND', 404);
      if (expectedVersion != null && Number(before.version) !== expectedVersion) throw conflict(await readOne(id, client));
      await client.query(DELETE_SQL, [id]);
      await client.query(CHANGE_SQL, [id, 'delete', actor, JSON.stringify(snapshot(before)), null]);
      const recalc = await applyRecalc(client, [{ branch: before.branch, customerId: before.customer_id,
        productId: before.product_id, fromDay: before.approved_on }], now());
      return { id, recalc };
    });
  }

  // ---- import: dong tho (approvedPriceImport.parseImportWorkbook) -> ke hoach tung dong (create / update / unchanged / error).
  async function planImport(db, rawRows, lock) {
    const items = rawRows.map(line => {
      const check = validateRow(line);
      return { row: line.row, customerCode: line.customerCode, productCode: line.productCode, status: check.ok ? 'pending' : 'error',
        message: check.ok ? '' : check.message, value: check.ok ? check.value : null };
    });
    const codeMap = async (sql, branch, codes) => {
      const map = new Map();
      for (const r of (await db.query(sql, [branch, codes])).rows) {
        if (!map.has(r.code)) map.set(r.code, []);
        map.get(r.code).push(r);
      }
      return map;
    };
    for (const branch of ['hanoi', 'saigon']) {
      const part = items.filter(i => i.value && i.value.branch === branch);
      if (!part.length) continue;
      const customers = await codeMap(IMPORT_CUSTOMERS_SQL, branch, [...new Set(part.map(i => i.value.customerCode.toLowerCase()))]);
      const products = await codeMap(IMPORT_PRODUCTS_SQL, branch, [...new Set(part.map(i => i.value.productCode.toLowerCase()))]);
      for (const i of part) {
        const cs = customers.get(i.value.customerCode.toLowerCase()) || [];
        const ps = products.get(i.value.productCode.toLowerCase()) || [];
        if (cs.length !== 1) i.message = cs.length ? `Mã KH "${i.value.customerCode}" trùng ${cs.length} khách trên KiotViet.` : `Mã KH "${i.value.customerCode}" không có trên KiotViet ${BRANCH_LABELS[branch]} (hoặc khách đã ngừng hoạt động).`;
        else if (ps.length !== 1) i.message = ps.length ? `Mã SP "${i.value.productCode}" trùng ${ps.length} sản phẩm trên KiotViet.` : `Mã SP "${i.value.productCode}" không có trên KiotViet ${BRANCH_LABELS[branch]}.`;
        if (i.message) { i.status = 'error'; continue; }
        i.customerId = cs[0].id;
        i.customerName = cs[0].name;
        i.productId = ps[0].id;
        i.productName = ps[0].name;
      }
    }
    const seen = new Map();
    for (const i of items.filter(x => x.status === 'pending')) {
      const key = `${i.value.branch}:${i.customerId}:${i.productId}:${i.value.approvedOn}`;
      if (seen.has(key)) { i.status = 'error'; i.message = `Trùng dòng ${seen.get(key)} trong file (cùng khách, mã SP, cơ sở và ngày duyệt).`; } else seen.set(key, i.row);
    }
    const ready = items.filter(i => i.status === 'pending');
    if (!ready.length) return items;
    const existing = new Map((await db.query(importExistingSql(lock), [ready.map(i => i.value.branch), ready.map(i => i.customerId),
      ready.map(i => i.productId), ready.map(i => i.value.approvedOn)])).rows
      .map(r => [`${r.branch}:${r.customer_id}:${r.product_id}:${r.approved_on}`, r]));
    for (const i of ready) {
      const ex = existing.get(`${i.value.branch}:${i.customerId}:${i.productId}:${i.value.approvedOn}`);
      if (!ex) { i.status = 'create'; continue; }
      i.existing = ex;
      i.priceChanged = !samePrice(ex.price_no_vat, i.value.priceNoVat) || !samePrice(ex.price_with_vat, i.value.priceWithVat);
      i.status = i.priceChanged || ex.approver !== i.value.approver ? 'update' : 'unchanged';
    }
    return items;
  }

  function importResult(items, commit, recalc) {
    const count = status => items.filter(i => i.status === status).length;
    return {
      commit, recalc: recalc || null,
      summary: { total: items.length, create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') },
      rows: items.map(i => ({ row: i.row, status: i.status, message: i.message || '', customerCode: i.customerCode, customerName: i.customerName || '',
        productCode: i.productCode, productName: i.productName || '', branchLabel: i.value ? BRANCH_LABELS[i.value.branch] : '',
        priceNoVat: i.value ? i.value.priceNoVat : null, priceWithVat: i.value ? i.value.priceWithVat : null,
        approver: i.value ? i.value.approver : '', approvedOn: i.value ? i.value.approvedOn : '' }))
    };
  }

  /**
   * Nhap hang loat tu dong tho da doc (<= MAX_IMPORT_ROWS). commit=false: chi xem truoc (khong ghi). commit=true: 1 giao dich ghi cac dong
   * hop le (dong loi bo qua, dong trung ban ghi da co thi GHI DE gia + nguoi duyet va ghi nhat ky 'update'), roi tinh lai Kiem tra gia ban 1 lan.
   */
  async function importPrices(rawRows, actor, { commit = false } = {}) {
    if (!commit) return importResult(await planImport(pool, rawRows, false), false, null);
    return inTransaction(async client => {
      const items = await planImport(client, rawRows, true);
      const scopes = [];
      for (const i of items) {
        const v = i.value;
        if (i.status === 'create') {
          const id = (await client.query(INSERT_SQL, [v.branch, i.customerId, i.productId, v.priceNoVat, v.priceWithVat, v.approver, v.approvedOn, actor])).rows[0].id;
          await client.query(CHANGE_SQL, [id, 'create', actor, null, JSON.stringify(snapshot({ ...v, customerId: i.customerId, productId: i.productId, version: 1 }))]);
          scopes.push({ branch: v.branch, customerId: i.customerId, productId: i.productId, fromDay: v.approvedOn });
        } else if (i.status === 'update') {
          const ex = i.existing;
          const updated = (await client.query(UPDATE_SQL, [ex.id, v.branch, i.customerId, i.productId, v.priceNoVat, v.priceWithVat, v.approver,
            v.approvedOn, actor, Number(ex.version)])).rows[0];
          if (!updated) throw conflict(null);
          await client.query(CHANGE_SQL, [ex.id, 'update', actor, JSON.stringify(snapshot(ex)),
            JSON.stringify(snapshot({ ...v, customerId: i.customerId, productId: i.productId, version: Number(updated.version) }))]);
          if (i.priceChanged) scopes.push({ branch: v.branch, customerId: i.customerId, productId: i.productId, fromDay: v.approvedOn });
        }
      }
      return importResult(items, true, await applyRecalc(client, scopes, now()));
    });
  }

  // ---- goi y: doc toan bo (id, ma, ten) cua co so, cache ngan trong bo nho, loc gan dung (bo dau) o JS.
  const cache = new Map();
  async function cached(kind, branch, sql) {
    const key = `${kind}:${branch}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < SUGGEST_TTL_MS) return hit.rows;
    const rows = (await pool.query(sql, [branch])).rows
      .map(r => ({ id: r.id, code: r.code, name: r.name, folded: fuzzy.fold(`${r.code} ${r.name}`), foldedCode: fuzzy.fold(r.code) }));
    cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  function search(rows, q, limit) {
    const matcher = fuzzy.createMatcher(q);
    const code = fuzzy.fold(String(q || '').trim());
    const scored = [];
    for (const r of rows) {
      const score = matcher.score(r.folded);
      if (score > 0) scored.push([score + (code && r.foldedCode.startsWith(code) ? 100 : 0), r]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, 'vi'));
    return scored.slice(0, limit).map(([, r]) => ({ id: r.id, code: r.code, name: r.name }));
  }

  const customerSql = `SELECT c.id::text AS id, COALESCE(c.code, '') AS code, c.name FROM customers c
    WHERE c.branch = $1 AND ${ACTIVE_CUSTOMER_SQL} AND btrim(COALESCE(c.name, '')) <> ''`;
  const productSql = `SELECT id::text AS id, code, name FROM products WHERE branch = $1 AND COALESCE(is_active, TRUE)`;

  async function suggestCustomers(branch, q, limit = SUGGEST_LIMIT) {
    return search(await cached('customer', branch, customerSql), q, Math.min(limit, 50));
  }
  async function suggestProducts(branch, q, limit = SUGGEST_LIMIT) {
    return search(await cached('product', branch, productSql), q, Math.min(limit, 50));
  }

  return { list, readOne, create, update, remove, importPrices, suggestCustomers, suggestProducts };
}

let defaultRepository;
function getApprovedPriceRepository() {
  if (!defaultRepository) defaultRepository = createApprovedPriceRepository();
  return defaultRepository;
}

module.exports = { createApprovedPriceRepository, getApprovedPriceRepository, MAX_EXPORT_ROWS, applyRecalc };
