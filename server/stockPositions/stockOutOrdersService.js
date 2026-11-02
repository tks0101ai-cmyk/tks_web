'use strict';

// Don xuat kho cua VT Ha Noi / VT Sai Gon (migration 0104): MOI co so co DUNG MOT don tam dung chung, nhieu nguoi cung them/sua/xoa dong.
// Don tam KHONG dong vao ton VT; chi "Chot don" moi tru ton that (cho phep SL am: public/shared/carton.js subtractNotes) va ghi lich su
// stock_position_history action 'stock_out' kem summary { source: 'order', orderId, orderCode } de bam ma don xem chi tiet.
// Dong trong don tam giu nguyen theo y nguoi nhap (khong gop); luc chot moi tru lan luot tung dong tren cung (ma, vi tri).
const { getPool } = require('../db/pool');
const carton = require('../public/shared/carton.js');
const { parseImportWorkbook } = require('./stockPositionsImport');
const { keyOf, tx } = require('./stockPositionsService');

const { withTransaction, lockBranch, writeHistory, fail, assertBranch, assertScope, actorOf, normalizeLocation, lower, isoOf, ROW_COLUMNS, DB_BRANCH } = tx;

const MAX = Object.freeze({ code: 60, notes: 500, location: 100 });
const IMPORT_ERROR_LIMIT = 500;
const HISTORY_LIMIT = 50;

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const normalizeCode = value => String(value ?? '').replace(/\s+/gu, '').toLocaleUpperCase('vi');

const RESOLVE_SQL = `SELECT code, name FROM products WHERE branch = $1 AND lower(regexp_replace(code, '\\s+', '', 'g')) = ANY($2::text[])`;
const HELD_SQL = `
  SELECT l.position_id, COALESCE(SUM(l.reserved_qty), 0)::float8 AS held
  FROM order_pick_lines l JOIN order_pick_assignments a ON a.id = l.assignment_id
  WHERE a.status = 'picking' AND a.branch = $1 AND l.position_id = ANY($2::bigint[])
  GROUP BY l.position_id`;
const LINE_COLUMNS = 'id, order_id, sort_order, code, name, location, notes, source, version, created_by_name, updated_at, result';
const ORDER_COLUMNS = 'id, branch, code, status, version, created_by_name, created_at, updated_at, confirmed_by_name, confirmed_at, summary';

const lockOrders = (client, branch) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['stock_out_orders:' + branch]);

// Ghi chu cua dong xuat: phai doc duoc va co SL nguyen duong. Tra { notes (da chuan hoa), spec }.
function parseLineNotes(raw) {
  const notes = carton.normalizeStoredNote(clean(raw));
  if (notes.length > MAX.notes) throw fail(400, 'VALIDATION', `Ghi chú tối đa ${MAX.notes} ký tự.`, { field: 'notes' });
  const spec = carton.parseSpec(notes);
  if (!spec || spec.empty || !Number.isSafeInteger(spec.quantity) || spec.quantity <= 0) {
    throw fail(400, 'VALIDATION', 'Ghi chú thùng sai định dạng hoặc không có số lượng (vd 5T x 100).', { field: 'notes' });
  }
  return { notes, spec };
}

function textOf(body, field, label) {
  const value = field === 'code' ? normalizeCode(body[field]) : clean(body[field]);
  if (value.length > MAX[field]) throw fail(400, 'VALIDATION', `${label} tối đa ${MAX[field]} ký tự.`, { field });
  return value;
}

/* Thuan tuy: tu cac dong cua don + dong VT hien co + giu cho -> ke hoach chot.
   positions: Map(keyOf) -> dong VT; heldById: Map(id dong VT) -> SL giu cho cua don Dang boc.
   Moi (ma, vi tri) la 1 nhom, cac dong tru lan luot theo thu tu dong tren ghi chu dang con lai. Chua co dong VT thi coi ton 0 (ra dong am).
   Nhom co ghi chu VT khong doc duoc (hoac dong don sai) bi chan (blocked) de khong tru bua. */
function buildPlan(lines, positions, heldById) {
  const groups = new Map();
  const perLine = new Map();
  for (const line of lines) {
    const key = keyOf(line.code, line.location);
    let group = groups.get(key);
    if (!group) {
      const existing = positions.get(key) || null;
      const start = existing ? carton.parseSigned(carton.normalizeStoredNote(existing.notes)) : null;
      group = {
        key, code: existing ? existing.code : normalizeCode(line.code), location: existing ? existing.location : normalizeLocation(line.location),
        name: clean(line.name), existing, startNotes: existing ? existing.notes : '', notes: existing ? existing.notes : carton.EMPTY_NOTE,
        startQuantity: existing ? (start ? start.quantity : null) : 0, quantity: existing ? (start ? start.quantity : null) : 0,
        lineIds: [], deducted: 0, held: existing ? heldById.get(Number(existing.id)) || 0 : 0,
        blocked: Boolean(existing && !start), reason: existing && !start ? 'Ghi chú của dòng VT đang lưu không đọc được nên không trừ được.' : ''
      };
      groups.set(key, group);
    }
    const spec = carton.parseSpec(carton.normalizeStoredNote(line.notes));
    const quantity = spec && !spec.empty ? spec.quantity : 0;
    const before = group.notes;
    const result = !group.blocked && spec && Number.isSafeInteger(quantity) && quantity > 0 ? carton.subtractNotes(before, quantity, spec.perCarton) : null;
    if (!result) {
      if (!group.blocked) { group.blocked = true; group.reason = 'Ghi chú của dòng xuất sai định dạng hoặc không có số lượng.'; }
      perLine.set(Number(line.id), { before: group.existing ? before : '', after: null, blocked: true, missing: !group.existing, held: group.held, reason: group.reason });
      continue;
    }
    group.notes = result.text;
    group.quantity = result.quantity;
    group.deducted += quantity;
    group.lineIds.push(Number(line.id));
    perLine.set(Number(line.id), { before: group.existing ? before : '', after: result.text, quantity: result.quantity, negative: result.quantity < 0, missing: !group.existing, held: group.held, blocked: false });
  }
  for (const group of groups.values()) {
    group.negative = !group.blocked && group.quantity < 0;
    group.removed = !group.blocked && group.quantity === 0 && group.held === 0 && Boolean(group.existing);
    group.heldShort = !group.blocked && group.held > 0 && group.quantity < group.held;
  }
  return { groups: [...groups.values()], perLine };
}

function createStockOutOrdersService({ getDb = getPool, now = () => Date.now() } = {}) {
  async function heldMap(db, branch, ids) {
    const held = new Map();
    if (!ids.length) return held;
    const probe = (await db.query(`SELECT to_regclass('order_pick_lines') IS NOT NULL AND to_regclass('order_pick_assignments') IS NOT NULL AS ready`)).rows[0];
    if (!probe || !probe.ready) return held; // chua ap migration 0096: khong co giu cho
    for (const row of (await db.query(HELD_SQL, [branch, ids])).rows) held.set(Number(row.position_id), Number(row.held));
    return held;
  }

  async function resolveCodes(db, branch, codes) {
    const keys = [...new Set(codes.map(lower).filter(Boolean))];
    const map = new Map();
    if (!keys.length) return map;
    for (const row of (await db.query(RESOLVE_SQL, [DB_BRANCH[branch], keys])).rows) map.set(lower(row.code), { code: normalizeCode(row.code), name: clean(row.name) });
    return map;
  }

  // Dong VT hien co theo (ma, vi tri); trung thi lay dong id nho nhat. lock = FOR UPDATE (luc chot).
  async function loadPositions(db, branch, lines, lock) {
    const codes = [...new Set(lines.map(line => lower(line.code)))];
    const positions = new Map();
    if (!codes.length) return positions;
    const { rows } = await db.query(
      `SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND lower(regexp_replace(code, '\\s+', '', 'g')) = ANY($2::text[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      [branch, codes]);
    for (const row of rows) {
      const key = keyOf(row.code, row.location);
      if (!positions.has(key)) positions.set(key, row);
    }
    return positions;
  }

  async function nextCode(client, branch) {
    const { rows } = await client.query(`SELECT COALESCE(MAX((regexp_match(code, '(\\d+)$'))[1]::int), 0) + 1 AS n FROM stock_out_orders WHERE branch = $1`, [branch]);
    return `XK-${branch}-${String(rows[0].n).padStart(5, '0')}`;
  }

  const lineOut = (line, preview = null) => {
    const spec = carton.parseSpec(line.notes);
    return {
      id: Number(line.id), orderId: Number(line.order_id), sortOrder: line.sort_order, code: line.code, name: clean(line.name), location: line.location,
      notes: line.notes, quantity: spec ? spec.quantity : null, source: line.source, version: line.version, createdByName: line.created_by_name,
      updatedAt: isoOf(line.updated_at), result: line.result || null, preview
    };
  };
  const orderOut = (order, lines, perLine = null) => ({
    id: Number(order.id), branch: order.branch, code: order.code, status: order.status, version: order.version,
    createdByName: order.created_by_name, createdAt: isoOf(order.created_at), updatedAt: isoOf(order.updated_at),
    confirmedByName: order.confirmed_by_name || null, confirmedAt: order.confirmed_at ? isoOf(order.confirmed_at) : null, summary: order.summary || null,
    lines: lines.map(line => lineOut(line, perLine ? perLine.get(Number(line.id)) || null : null))
  });

  async function loadLines(db, orderId) {
    return (await db.query(`SELECT ${LINE_COLUMNS} FROM stock_out_order_lines WHERE order_id = $1 ORDER BY sort_order, id`, [orderId])).rows;
  }

  // Xem truoc ket qua chot cua don tam (ghi chu truoc/sau, dong am, giu cho) theo ton VT hien tai.
  async function previewOf(db, order, lines) {
    if (order.status !== 'draft' || !lines.length) return null;
    const positions = await loadPositions(db, order.branch, lines, false);
    const held = await heldMap(db, order.branch, [...positions.values()].map(row => Number(row.id)));
    return buildPlan(lines, positions, held);
  }

  async function currentDraft(db, branch) {
    return (await db.query(`SELECT ${ORDER_COLUMNS} FROM stock_out_orders WHERE branch = $1 AND status = 'draft'`, [branch])).rows[0] || null;
  }

  // Don tam dang mo cua co so. create = true: chua co thi tao (can quyen sua); false va chua co -> { order: null }.
  async function getCurrent(ctx, branch, { create = false } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const db = getDb();
    let order = await currentDraft(db, branch);
    if (!order && create) {
      const actor = actorOf(ctx);
      order = await withTransaction(db, async client => {
        await lockOrders(client, branch);
        const again = await currentDraft(client, branch);
        if (again) return again;
        const code = await nextCode(client, branch);
        return (await client.query(
          `INSERT INTO stock_out_orders (branch, code, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4) RETURNING ${ORDER_COLUMNS}`,
          [branch, code, actor.id, actor.name])).rows[0];
      });
    }
    if (!order) return { order: null };
    const lines = await loadLines(db, order.id);
    const plan = await previewOf(db, order, lines);
    return { order: orderOut(order, lines, plan ? plan.perLine : null), blockedGroups: plan ? plan.groups.filter(g => g.blocked).length : 0 };
  }

  // Khoa don tam (FOR UPDATE) de them/sua/xoa dong; kiem pham vi co so. Don da chot -> 409.
  async function lockDraft(client, ctx, orderId) {
    const head = (await client.query('SELECT branch FROM stock_out_orders WHERE id = $1', [orderId])).rows[0];
    if (!head) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn xuất kho.');
    assertScope(ctx, head.branch);
    await lockOrders(client, head.branch);
    const order = (await client.query(`SELECT ${ORDER_COLUMNS} FROM stock_out_orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn xuất kho.');
    if (order.status !== 'draft') throw fail(409, 'ORDER_CONFIRMED', 'Đơn này đã chốt nên không sửa được nữa.');
    return order;
  }

  const touchOrder = (client, orderId) => client.query('UPDATE stock_out_orders SET version = version + 1, updated_at = now() WHERE id = $1', [orderId]);

  async function addLine(ctx, orderId, body = {}) {
    const code = textOf(body, 'code', 'Mã hàng');
    if (!code) throw fail(400, 'VALIDATION', 'Vui lòng chọn hoặc nhập mã hàng.', { field: 'code' });
    const location = normalizeLocation(textOf(body, 'location', 'Vị trí'));
    if (!location) throw fail(400, 'VALIDATION', 'Vui lòng nhập vị trí.', { field: 'location' });
    const { notes } = parseLineNotes(body.notes);
    const source = body.source === 'excel' ? 'excel' : 'manual';
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      const order = await lockDraft(client, ctx, orderId);
      const product = (await resolveCodes(client, order.branch, [code])).get(lower(code));
      const next = (await client.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM stock_out_order_lines WHERE order_id = $1', [order.id])).rows[0].n;
      const { rows } = await client.query(
        `INSERT INTO stock_out_order_lines (order_id, sort_order, code, name, location, notes, source, created_by_user_id, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${LINE_COLUMNS}`,
        [order.id, next, product ? product.code : code, product ? product.name : clean(body.name), location, notes, source, actor.id, actor.name]);
      await touchOrder(client, order.id);
      return { line: lineOut(rows[0]), orderVersion: order.version + 1 };
    });
  }

  async function updateLine(ctx, lineId, body = {}) {
    return withTransaction(getDb(), async client => {
      const head = (await client.query('SELECT order_id FROM stock_out_order_lines WHERE id = $1', [lineId])).rows[0];
      if (!head) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng đơn xuất kho (có thể đã bị xóa).');
      const order = await lockDraft(client, ctx, Number(head.order_id));
      const row = (await client.query(`SELECT ${LINE_COLUMNS} FROM stock_out_order_lines WHERE id = $1 FOR UPDATE`, [lineId])).rows[0];
      if (!row) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng đơn xuất kho (có thể đã bị xóa).');
      if (body.version !== undefined && body.version !== null && Number(body.version) !== row.version) {
        throw fail(409, 'VERSION_CONFLICT', 'Dòng đã bị người khác sửa. Dữ liệu mới nhất đã được tải lại.', { latest: lineOut(row) });
      }
      let { code, name, location, notes } = row;
      if (body.code !== undefined) {
        code = textOf(body, 'code', 'Mã hàng');
        if (!code) throw fail(400, 'VALIDATION', 'Vui lòng chọn hoặc nhập mã hàng.', { field: 'code' });
        const product = (await resolveCodes(client, order.branch, [code])).get(lower(code));
        if (product) { code = product.code; name = product.name; } else if (code !== row.code) name = clean(body.name);
      }
      if (body.location !== undefined) {
        location = normalizeLocation(textOf(body, 'location', 'Vị trí'));
        if (!location) throw fail(400, 'VALIDATION', 'Vui lòng nhập vị trí.', { field: 'location' });
      }
      if (body.notes !== undefined) notes = parseLineNotes(body.notes).notes;
      const { rows } = await client.query(
        `UPDATE stock_out_order_lines SET code = $2, name = $3, location = $4, notes = $5, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING ${LINE_COLUMNS}`, [lineId, code, name, location, notes]);
      await touchOrder(client, order.id);
      return { line: lineOut(rows[0]), orderVersion: order.version + 1 };
    });
  }

  async function removeLine(ctx, lineId, version) {
    return withTransaction(getDb(), async client => {
      const head = (await client.query('SELECT order_id FROM stock_out_order_lines WHERE id = $1', [lineId])).rows[0];
      if (!head) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng đơn xuất kho (có thể đã bị xóa).');
      const order = await lockDraft(client, ctx, Number(head.order_id));
      const row = (await client.query(`SELECT ${LINE_COLUMNS} FROM stock_out_order_lines WHERE id = $1 FOR UPDATE`, [lineId])).rows[0];
      if (!row) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng đơn xuất kho (có thể đã bị xóa).');
      if (version !== undefined && version !== null && Number(version) !== row.version) {
        throw fail(409, 'VERSION_CONFLICT', 'Dòng đã bị người khác sửa. Dữ liệu mới nhất đã được tải lại.', { latest: lineOut(row) });
      }
      await client.query('DELETE FROM stock_out_order_lines WHERE id = $1', [lineId]);
      await touchOrder(client, order.id);
      return { deleted: true, id: Number(lineId), orderVersion: order.version + 1 };
    });
  }

  // Nap dong tu file Excel/CSV (3 cot Ma hang, Ghi chu, Vi tri) vao don tam; dong sai bo qua + liet ke, dong dung van them.
  async function importLines(ctx, orderId, { buffer, fileName = '' } = {}) {
    if (!buffer || !buffer.length) throw fail(400, 'IMPORT_FILE_REQUIRED', 'Vui lòng chọn file Excel hoặc CSV.');
    const fileRows = parseImportWorkbook(buffer, { fileName, now: new Date(now()), requireArrivalDate: false });
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      const order = await lockDraft(client, ctx, orderId);
      const errors = [];
      const valid = [];
      for (const entry of fileRows) {
        const reject = message => errors.push({ row: entry.row, code: clean(entry.code), location: clean(entry.location), notes: clean(entry.notes), message });
        const code = normalizeCode(entry.code);
        const location = normalizeLocation(entry.location);
        if (!code) { reject('Thiếu mã hàng.'); continue; }
        if (!location) { reject('Thiếu vị trí.'); continue; }
        if (code.length > MAX.code || location.length > MAX.location) { reject('Mã hàng hoặc vị trí quá dài.'); continue; }
        try { valid.push({ code, location, notes: parseLineNotes(entry.notes).notes }); }
        catch { reject('Ghi chú sai định dạng hoặc không có số lượng (vd 1T x 50).'); }
      }
      if (valid.length) {
        const products = await resolveCodes(client, order.branch, valid.map(item => item.code));
        const start = Number((await client.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM stock_out_order_lines WHERE order_id = $1', [order.id])).rows[0].n);
        const col = pick => valid.map(pick);
        await client.query(
          `INSERT INTO stock_out_order_lines (order_id, sort_order, code, name, location, notes, source, created_by_user_id, created_by_name)
           SELECT $1, $2::int + t.ord, t.code, t.name, t.location, t.notes, 'excel', $3, $4
           FROM unnest($5::int[], $6::text[], $7::text[], $8::text[], $9::text[]) AS t(ord, code, name, location, notes)`,
          [order.id, start, actor.id, actor.name, col((_, index) => index + 1), col(item => (products.get(lower(item.code)) || { code: item.code }).code),
            col(item => (products.get(lower(item.code)) || { name: '' }).name), col(item => item.location), col(item => item.notes)]);
        await touchOrder(client, order.id);
      }
      return {
        fileName, orderVersion: valid.length ? order.version + 1 : order.version,
        counts: { fileRows: fileRows.length, added: valid.length, skipped: errors.length },
        errors: errors.slice(0, IMPORT_ERROR_LIMIT), errorsTruncated: errors.length > IMPORT_ERROR_LIMIT
      };
    });
  }

  /* Chot don: trong 1 giao dich co khoa co so (cung khoa voi moi thao tac ghi VT) tru ton VT theo tung (ma, vi tri).
     version = phien ban don nguoi dung dang xem; don da doi (nguoi khac them/sua dong) -> 409 de ho xem lai truoc khi chot. */
  async function confirm(ctx, orderId, body = {}) {
    const actor = actorOf(ctx);
    const db = getDb();
    const head = (await db.query('SELECT branch FROM stock_out_orders WHERE id = $1', [orderId])).rows[0];
    if (!head) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn xuất kho.');
    assertScope(ctx, head.branch);
    return withTransaction(db, async client => {
      await lockBranch(client, head.branch);
      const order = (await client.query(`SELECT ${ORDER_COLUMNS} FROM stock_out_orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!order) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn xuất kho.');
      if (order.status !== 'draft') throw fail(409, 'ORDER_CONFIRMED', 'Đơn này đã được chốt rồi.');
      if (body.version !== undefined && body.version !== null && Number(body.version) !== order.version) {
        throw fail(409, 'VERSION_CONFLICT', 'Đơn vừa được người khác thay đổi. Hãy xem lại đơn trước khi chốt.', { latest: orderOut(order, await loadLines(client, order.id)) });
      }
      const lines = await loadLines(client, order.id);
      if (!lines.length) throw fail(400, 'EMPTY_ORDER', 'Đơn chưa có dòng nào để chốt.');
      const positions = await loadPositions(client, order.branch, lines, true);
      const held = await heldMap(client, order.branch, [...positions.values()].map(row => Number(row.id)));
      const plan = buildPlan(lines, positions, held);
      const blocked = plan.groups.filter(group => group.blocked);
      if (blocked.length) {
        throw fail(400, 'ORDER_BLOCKED', `Có ${blocked.length} vị trí không trừ được: ${blocked.slice(0, 5).map(g => `${g.code} @ ${g.location}`).join(', ')}. Hãy sửa dòng đó rồi chốt lại.`, { blocked: blocked.map(g => ({ code: g.code, location: g.location, reason: g.reason })) });
      }
      const productNames = await resolveCodes(client, order.branch, plan.groups.map(group => group.code));
      const entries = [];
      const summaryBase = { source: 'order', orderId: Number(order.id), orderCode: order.code };
      const stats = { positions: plan.groups.length, lines: lines.length, quantity: 0, negative: 0, removed: 0, created: 0 };
      for (const group of plan.groups) {
        stats.quantity += group.deducted;
        const summary = { ...summaryBase, deducted: group.deducted, lineIds: group.lineIds, negative: group.negative, removed: group.removed, created: !group.existing };
        if (!group.existing) {
          const product = productNames.get(lower(group.code));
          const { rows } = await client.query(
            `INSERT INTO stock_positions (branch, code, name, notes, arrival_date, location, updated_by_user_id, updated_by_name) VALUES ($1, $2, $3, $4, '', $5, $6, $7) RETURNING id`,
            [order.branch, product ? product.code : group.code, product ? product.name : group.name, group.notes, group.location, actor.id, actor.name]);
          group.positionId = Number(rows[0].id);
          stats.created += 1;
          entries.push({ positionId: group.positionId, code: group.code, location: group.location, action: 'stock_out', field: 'notes', oldValue: null, newValue: group.notes, summary });
        } else if (group.removed) {
          await client.query('DELETE FROM stock_positions WHERE id = $1', [group.existing.id]);
          group.positionId = Number(group.existing.id);
          stats.removed += 1;
          entries.push({ positionId: group.positionId, code: group.existing.code, location: group.existing.location, action: 'stock_out', field: 'notes', oldValue: group.startNotes, newValue: null, summary });
        } else {
          await client.query(
            `UPDATE stock_positions SET notes = $2, version = version + 1, updated_by_user_id = $3, updated_by_name = $4, updated_at = now() WHERE id = $1`,
            [group.existing.id, group.notes, actor.id, actor.name]);
          group.positionId = Number(group.existing.id);
          entries.push({ positionId: group.positionId, code: group.existing.code, location: group.existing.location, action: 'stock_out', field: 'notes', oldValue: group.startNotes, newValue: group.notes, summary });
        }
        if (group.negative) stats.negative += 1;
      }
      await writeHistory(client, order.branch, actor, entries);
      const groupOf = new Map(plan.groups.flatMap(group => group.lineIds.map(id => [id, group])));
      const ids = lines.map(line => Number(line.id));
      const results = lines.map(line => {
        const info = plan.perLine.get(Number(line.id));
        return JSON.stringify({ before: info.before, after: info.after, quantity: info.quantity, negative: info.negative, created: info.missing, positionId: groupOf.get(Number(line.id)).positionId || null });
      });
      await client.query(
        `UPDATE stock_out_order_lines l SET result = t.result::jsonb FROM unnest($1::bigint[], $2::text[]) AS t(id, result) WHERE l.id = t.id`, [ids, results]);
      const confirmed = (await client.query(
        `UPDATE stock_out_orders SET status = 'confirmed', version = version + 1, updated_at = now(), confirmed_by_user_id = $2, confirmed_by_name = $3, confirmed_at = now(), summary = $4::jsonb
         WHERE id = $1 RETURNING ${ORDER_COLUMNS}`, [order.id, actor.id, actor.name, JSON.stringify(stats)])).rows[0];
      return { order: orderOut(confirmed, await loadLines(client, order.id)), stats };
    });
  }

  async function list(ctx, branch, { limit, before } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const size = Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), 200);
    const cursor = Number(before);
    const { rows } = await getDb().query(
      `SELECT ${ORDER_COLUMNS}, (SELECT count(*) FROM stock_out_order_lines l WHERE l.order_id = o.id)::int AS line_count
       FROM stock_out_orders o WHERE branch = $1 AND status = 'confirmed' AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [branch, Number.isFinite(cursor) && cursor > 0 ? cursor : null, size]);
    return { branch, orders: rows.map(row => ({ ...orderOut(row, []), lineCount: row.line_count })) };
  }

  async function get(ctx, orderId) {
    const db = getDb();
    const order = (await db.query(`SELECT ${ORDER_COLUMNS} FROM stock_out_orders WHERE id = $1`, [orderId])).rows[0];
    if (!order) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn xuất kho.');
    assertScope(ctx, order.branch);
    const lines = await loadLines(db, order.id);
    const plan = await previewOf(db, order, lines);
    return { order: orderOut(order, lines, plan ? plan.perLine : null) };
  }

  return { getCurrent, addLine, updateLine, removeLine, importLines, confirm, list, get };
}

module.exports = { createStockOutOrdersService, buildPlan, ...createStockOutOrdersService() };
