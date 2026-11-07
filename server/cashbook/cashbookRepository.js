'use strict';
const { getPool } = require('../db/pool');
const { stripTelegramId, saleNameSql } = require('../dashboard/saleName');
const { buildWhere } = require('./cashbookFilters');
const CONFIG = require('../config');
// Mọi truy vấn đọc phiếu thu/chi qua view v_cash_book_transactions (migration 0070):
// fund_key, số TK/chủ TK và các trường rút sẵn từ raw nằm một chỗ, không kéo cột raw.
// Thiếu view (42P01, chưa migrate) thì tự lùi về đúng nội dung view dưới dạng subquery
// (CASH_BOOK_TRANSACTIONS_SELECT) nên cùng một câu SQL chạy được cả hai đường.
// Test db/cashBookViewMigration.test.js bắt buộc hai bản này giống hệt nhau.
const VIEW_NAME = 'v_cash_book_transactions';
const CASH_BOOK_TRANSACTIONS_SELECT = `SELECT c.branch,c.id,c.code,c.trans_date,c.is_receipt,c.amount,
  c.method,c.status,c.account_id,c.user_id,c.description,c.source_missing_at,
  CASE WHEN c.method='Cash' THEN 'cash'
    WHEN c.account_id IS NULL THEN 'unassigned' ELSE c.account_id::text END AS fund_key,
  a.account_no,a.bank_name AS account_name,a.description AS account_desc,
  COALESCE(c.raw->>'CashFlowGroupId',c.raw->>'cashFlowGroupId') AS cash_group_id,
  COALESCE(c.raw->>'CashGroup',c.raw->>'cashGroup') AS cash_group_name,
  COALESCE(c.raw->>'PartnerId',c.raw->>'partnerId') AS partner_id,
  COALESCE(c.raw->>'PartnerName',c.raw->>'partnerName') AS partner_name,
  COALESCE(c.raw->>'ContactNumber',c.raw->>'contactNumber') AS partner_phone,
  COALESCE(c.raw->>'CreatedBy',c.raw->>'createdBy') AS created_by,
  COALESCE(c.raw->>'User',c.raw->>'user') AS user_name,
  COALESCE(c.raw->>'UserId',c.raw->>'userId') AS raw_user_id,
  COALESCE(c.raw->>'UsedForFinancialReporting',c.raw->>'usedForFinancialReporting') AS used_for_financial_reporting
FROM cash_flows c LEFT JOIN cash_book_accounts a ON a.id=c.account_id`;
// Sau khi lùi về subquery, thử lại view sau chừng này ms (để nhận view khi vừa migrate xong).
const VIEW_RETRY_MS = 5 * 60 * 1000;
const inlineView = (sql) =>
  sql.split(VIEW_NAME).join(`(${CASH_BOOK_TRANSACTIONS_SELECT})`);
// Mọi quỹ đã từng xuất hiện: tiền mặt, danh mục KiotViet và ID lịch sử chỉ còn trong phiếu.
const fundsSql = `SELECT 'cash' fund_key,NULL::bigint account_id
  UNION SELECT id::text,id FROM cash_book_accounts
  UNION SELECT DISTINCT c.fund_key,CASE WHEN c.method='Cash' THEN NULL ELSE c.account_id END FROM ${VIEW_NAME} c WHERE c.source_missing_at IS NULL`;
const numeric = (v) => (v == null ? null : Number(v));
const BRANCH_KEYS = { hanoi: 'balanceHanoi', saigon: 'balanceSaigon' };
const FUND_GROUPS = ['Anh Quân', 'Chị Nguyệt', 'Anh Duy', 'Công ty', 'Khác'];
// Danh sách số TK đã đối chiếu với ảnh: không suy ra nhóm từ tên chủ TK.
const GROUP_ACCOUNT_NUMBERS = [
  ['80002809285', '10003099363', '48206877'],
  ['181833666', '3090345688', '52256368', '0034100123456688'],
  ['8040890', '80002808041', '087564570', '72104081990', '00001066788', '1026044272'],
  ['1069579742', '6062.666.88888', '898896886', '525345345', '658999', '686345345', '464848'],
];
function fundGroup(accountNo) {
  const index = GROUP_ACCOUNT_NUMBERS.findIndex(numbers => numbers.includes(accountNo));
  return index < 0 ? 'Khác' : FUND_GROUPS[index];
}
// HN và SG là 2 retailer KiotViet nên cùng một tài khoản ngân hàng có 2 ID.
// Gộp theo số TK; khóa quỹ là danh sách ID nên dùng thẳng làm bộ lọc `fund`.
function groupFunds(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = r.account_id == null ? null : String(r.account_id);
    const no = (r.account_no || '').trim();
    const special = r.fund_key === 'unassigned' ? 'unassigned' : id == null ? 'cash' : null;
    const key = special || (no ? `no:${no}` : `id:${id}`);
    if (!groups.has(key))
      groups.set(key, { ids: [], special, accountNo: no, names: [], descriptions: [] });
    const g = groups.get(key);
    if (id != null) g.ids.push(id);
    const name = (r.bank_name || '').trim();
    const same = (x) => x.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi');
    if (name && name !== no && !g.names.some(same)) g.names.push(name);
    const note = (r.description || '').trim();
    if (note && !g.descriptions.includes(note)) g.descriptions.push(note);
  }
  const funds = [...groups.values()].map((g) => {
    const ids = g.ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    return {
      fund: g.special || ids.join(','),
      accountIds: ids,
      name: g.special
        ? g.special === 'cash' ? 'Tiền mặt' : 'Chưa xác định tài khoản'
        : g.names.join(' / ') ||
          g.accountNo ||
          `Tài khoản #${ids[0]} (không có trong danh sách KiotViet)`,
      accountNo: g.accountNo,
      accountGroup: g.special ? 'Khác' : fundGroup(g.accountNo),
      description: g.descriptions.join(' · '),
    };
  });
  return funds.sort(
    (a, b) =>
      (a.fund === 'cash' ? -1 : 0) - (b.fund === 'cash' ? -1 : 0) ||
      a.name.localeCompare(b.name, 'vi') ||
      a.accountNo.localeCompare(b.accountNo, 'vi', { numeric: true }),
  );
}
function selectedFunds(funds, fund) {
  if (fund === 'all') return funds;
  if (fund === 'cash' || fund === 'unassigned') return funds.filter((x) => x.fund === fund);
  if (fund === 'bank') return funds.filter((x) => x.fund !== 'cash');
  return funds.filter((x) => x.accountIds.some((id) => fund.includes(id)));
}
function createRepository(pool = getPool()) {
  let viewRetryAt = 0;
  // Chạy SQL viết cho view; lùi về subquery khi view chưa tồn tại.
  async function q(sql, params) {
    if (Date.now() < viewRetryAt) return pool.query(inlineView(sql), params);
    try {
      return await pool.query(sql, params);
    } catch (e) {
      if (!e || e.code !== '42P01' || !String(e.message).includes(VIEW_NAME)) throw e;
      // Các truy vấn chạy song song cùng lỗi: chỉ cảnh báo ở lần đầu.
      if (Date.now() >= viewRetryAt)
        console.warn(`[cashbook] thiếu view ${VIEW_NAME} (chưa chạy migration 0070): đọc trực tiếp cash_flows.`);
      viewRetryAt = Date.now() + VIEW_RETRY_MS;
      return pool.query(inlineView(sql), params);
    }
  }
  async function syncStatus() {
    // A tiny checkpoint query; never scan the voucher ledger for polling.
    const { rows } = await pool.query(`SELECT branch,entity,last_synced_at
      FROM sync_checkpoints WHERE entity IN ('cash_flows','cash_book_accounts')
      ORDER BY branch,entity`);
    return {
      revision: JSON.stringify(rows.map(r => [r.branch, r.entity,
        r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null])),
      enabled: CONFIG.KIOTVIET_SYNC_ENABLED || CONFIG.KIOTVIET_CASHBOOK_SYNC_ENABLED,
      intervalMs: CONFIG.KIOTVIET_CASHBOOK_SYNC_INTERVAL_MS,
      branches: rows.filter(r => r.entity === 'cash_flows').map(r => ({
        branch: r.branch, syncedAt: r.last_synced_at || null
      }))
    };
  }
  async function funds() {
    const rows = (
      await q(
        `SELECT a.fund_key,a.account_id,b.bank_name,b.account_no,b.description FROM (${fundsSql}) a
        LEFT JOIN cash_book_accounts b ON b.id=a.account_id`,
      )
    ).rows;
    return groupFunds(rows);
  }
  async function summary(f) {
    // Capture the revision before reading totals: a concurrent commit will
    // then trigger another refresh rather than hiding older rendered data.
    const sync = await syncStatus();
    // Tồn quỹ = Σ mọi phiếu chưa hủy (thu dương, chi âm) tới mốc, như Sổ quỹ KiotViet.
    // Bảng số dư luôn liệt kê mọi quỹ (người dùng tìm ở ô tìm kiếm); KPI Tồn quỹ theo quỹ đang chọn.
    // KPI thu/chi theo bộ lọc hiển thị, luôn loại phiếu hủy. Mốc sync không phụ thuộc bộ lọc.
    const w = buildWhere(f);
    const [catalog, sums, totals] = await Promise.all([
      funds(),
      q(
        `SELECT c.fund_key,c.branch,
          COALESCE(SUM(c.amount),0) closing_balance
        FROM ${VIEW_NAME} c WHERE c.source_missing_at IS NULL AND c.status IS DISTINCT FROM 1 AND c.trans_date<=$1::timestamptz
        GROUP BY c.fund_key,c.branch`,
        [f.to],
      ),
      q(
        `SELECT COALESCE(SUM(CASE WHEN c.is_receipt THEN c.amount ELSE 0 END),0) receipts,
          COALESCE(-SUM(CASE WHEN NOT c.is_receipt THEN c.amount ELSE 0 END),0) payments,
          (SELECT MAX(last_synced_at) FROM sync_checkpoints WHERE entity='cash_flows') synced_at
        FROM ${VIEW_NAME} c WHERE ${w.sql} AND c.status IS DISTINCT FROM 1`,
        w.params,
      ),
    ]);
    const byAccount = new Map();
    for (const r of sums.rows) {
      const key = r.fund_key;
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(r);
    }
    const chosen = new Set(selectedFunds(catalog, f.fund));
    let closingBalance = 0;
    const balances = catalog.map((fund) => {
      const row = { ...fund, balanceHanoi: 0, balanceSaigon: 0, balance: 0 };
      for (const key of fund.accountIds.length ? fund.accountIds : [fund.fund])
        for (const r of byAccount.get(key) || []) {
          const closing = Number(r.closing_balance);
          row.balance += closing;
          if (BRANCH_KEYS[r.branch]) row[BRANCH_KEYS[r.branch]] += closing;
          // Link cũ có thể chọn 1 ID của nhóm: KPI chỉ cộng ID nằm trong bộ lọc.
          if (chosen.has(fund) && (!Array.isArray(f.fund) || f.fund.includes(key)))
            closingBalance += closing;
        }
      return row;
    });
    const t = totals.rows[0];
    const totalBalance = balances.reduce((s, r) => s + r.balance, 0);
    return {
      balances,
      totalBalance,
      groupBalances: FUND_GROUPS.map(name => ({
        name,
        balance: balances.filter(row => row.accountGroup === name)
          .reduce((sum, row) => sum + row.balance, 0),
      })),
      kpis: {
        totalReceipts: Number(t.receipts),
        totalPayments: Number(t.payments),
        closingBalance,
      },
      syncedAt: t.synced_at || null,
      revision: sync.revision,
    };
  }
  async function entries(f, { exportLimit = null } = {}) {
    const w = buildWhere(f);
    const params = [...w.params];
    // Số dư lũy kế = tồn quỹ của các quỹ đang chọn ngay sau phiếu. Tính trên toàn
    // dòng thời gian của quỹ (trước khi lọc ngày/loại/trạng thái) nên luôn đúng.
    const tw = buildWhere(f, {
      alias: 't',
      fundOnly: true,
      start: params.length,
    });
    params.push(...tw.params, f.to);
    const timeline = `timeline AS (
      SELECT t.branch,t.id,
        SUM(CASE WHEN t.status IS DISTINCT FROM 1 THEN COALESCE(t.amount,0) ELSE 0 END)
          OVER(ORDER BY t.trans_date,t.id,t.branch ROWS UNBOUNDED PRECEDING) running_balance
      FROM ${VIEW_NAME} t WHERE ${tw.sql} AND t.trans_date<=$${params.length}::timestamptz
    )`;
    // Sorting uses display expressions across all filtered rows inside SQL, before LIMIT.
    // The small fund catalog supplies labels for merged HN/SG accounts as a bound JSON parameter.
    const sortedCatalog = f.sorts?.length ? await funds() : null;
    let sortSql = '';
    if (f.sorts?.length) {
      const labels = {};
      for (const fund of sortedCatalog) for (const id of fund.accountIds.length ? fund.accountIds : [fund.fund]) {
        labels[id] = fund.accountNo ? `${fund.accountNo} · ${fund.name}` : fund.name;
      }
      const sortingFund = f.sorts.some(layer => layer.key === 'fundName');
      if (sortingFund) params.push(JSON.stringify(labels));
      const fundLabel = sortingFund ? `COALESCE($${params.length}::jsonb->>c.fund_key, 'Tài khoản #' || c.account_id::text)` : 'c.fund_key';
      const expressions = {
        code: "NULLIF(c.code,'')", transDate: 'c.trans_date', docType: "CASE WHEN c.is_receipt THEN 'Thu' ELSE 'Chi' END",
        group: "NULLIF(c.cash_group_name,'')", partnerName: "NULLIF(c.partner_name,'')", partnerPhone: "NULLIF(c.partner_phone,'')",
        fundName: fundLabel, branch: 'c.branch',
        creatorName: `COALESCE(NULLIF(${saleNameSql('creator.name')},''),c.created_by)`,
        staffName: `COALESCE(NULLIF(${saleNameSql('c.user_name')},''),NULLIF(${saleNameSql('staff.name')},''),c.user_id::text)`,
        amount: 'c.amount', runningBalance: 't.running_balance', status: "CASE WHEN c.status=1 THEN 'Đã hủy' ELSE 'Đã thanh toán' END", note: "NULLIF(c.description,'')"
      };
      sortSql = require('../shared/multiSort').orderBy(f.sorts, expressions);
    }
    params.push(exportLimit || f.pageSize, exportLimit ? 0 : (f.page - 1) * f.pageSize);
    const sortedQuery = sortSql ? `WITH ${timeline}
      SELECT c.branch,c.id,c.code,c.trans_date,c.is_receipt,c.amount,c.status,
        c.account_id,c.user_id,c.description,c.fund_key,c.cash_group_name,
        c.partner_name,c.partner_phone,c.created_by,c.user_name,
        creator.name creator_name,staff.name staff_name,t.running_balance
      FROM ${VIEW_NAME} c
      LEFT JOIN timeline t ON t.branch=c.branch AND t.id=c.id
      LEFT JOIN staff creator ON creator.branch=c.branch AND creator.id::text=c.created_by
      LEFT JOIN staff staff ON staff.branch=c.branch AND staff.id=c.user_id
      WHERE ${w.sql}
      ORDER BY ${sortSql},c.trans_date DESC,c.id DESC,c.branch DESC
      LIMIT $${params.length-1} OFFSET $${params.length}` : null;
    const [catalog, count, result] = await Promise.all([
      sortedCatalog || funds(),
      q(
        `SELECT COUNT(*) total FROM ${VIEW_NAME} c WHERE ${w.sql}`,
        w.params,
      ),
      q(
        sortedQuery || `WITH ${timeline}, page AS (
          SELECT c.branch,c.id,c.code,c.trans_date,c.is_receipt,c.amount,c.status,
            c.account_id,c.user_id,c.description,c.fund_key,c.cash_group_name,
            c.partner_name,c.partner_phone,c.created_by,c.user_name${w.score ? `,${w.score} search_score` : ''}
          FROM ${VIEW_NAME} c WHERE ${w.sql}
          ORDER BY ${w.score ? `${w.score} DESC,` : ''}c.trans_date DESC,c.id DESC,c.branch DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        )
        SELECT c.*,creator.name creator_name,staff.name staff_name,t.running_balance
        FROM page c
        LEFT JOIN timeline t ON t.branch=c.branch AND t.id=c.id
        LEFT JOIN staff creator ON creator.branch=c.branch
          AND creator.id::text=c.created_by
        LEFT JOIN staff staff ON staff.branch=c.branch AND staff.id=c.user_id
        ORDER BY ${w.score ? 'c.search_score DESC,' : ''}c.trans_date DESC,c.id DESC,c.branch DESC`,
        params,
      ),
    ]);
    const total = Number(count.rows[0].total);
    const fundById = new Map();
    for (const fund of catalog)
      for (const id of fund.accountIds.length ? fund.accountIds : [fund.fund])
        fundById.set(id, fund);
    const entryFund = (r) => r.fund_key;
    const fundLabel = (r) => {
      const accountId = r.account_id;
      const fund = fundById.get(entryFund(r));
      if (!fund) return `Tài khoản #${accountId}`;
      return fund.accountNo ? `${fund.accountNo} · ${fund.name}` : fund.name;
    };
    const mapped = result.rows.map((r) => ({
        id: String(r.id),
        branch: r.branch,
        code: r.code || '',
        transDate: r.trans_date,
        docType: r.is_receipt ? 'receipt' : 'payment',
        group: r.cash_group_name ?? '',
        partnerName: r.partner_name ?? '',
        partnerPhone: r.partner_phone ?? '',
        fund: entryFund(r),
        fundName: fundLabel(r),
        creatorName:
          stripTelegramId(r.creator_name) ||
          String(r.created_by ?? ''),
        staffName:
          stripTelegramId(r.user_name) ||
          stripTelegramId(r.staff_name) ||
          String(r.user_id ?? ''),
        amount: numeric(r.amount),
        runningBalance: numeric(r.running_balance),
        status: r.status === 1 ? 'cancelled' : 'paid',
        note: r.description || '',
      }));
    return {
      entries: mapped,
      total,
      page: f.page,
      pageSize: f.pageSize,
      totalPages: Math.ceil(total / f.pageSize),
    };
  }
  async function filterOptions() {
    const rows = (
      await q(
        `SELECT DISTINCT c.cash_group_id group_id,
          c.cash_group_name group_name,
          c.created_by creator_id,
          creator.name creator_name,c.user_id,
          COALESCE(NULLIF(btrim(c.user_name),''),s.name) staff_name
        FROM ${VIEW_NAME} c
        LEFT JOIN staff creator ON creator.branch=c.branch
          AND creator.id::text=c.created_by
        LEFT JOIN staff s ON s.branch=c.branch AND s.id=c.user_id
        WHERE c.source_missing_at IS NULL`,
      )
    ).rows;
    const groups = new Map(),
      creators = new Map(),
      staff = new Map();
    for (const r of rows) {
      if (r.group_id || r.group_name) {
        const key = r.group_id || `name:${encodeURIComponent(r.group_name)}`;
        groups.set(key, { key, label: r.group_name || `Nhóm #${r.group_id}` });
      }
      if (r.creator_id) {
        const key = String(r.creator_id),
          label = stripTelegramId(r.creator_name) || `#${r.creator_id}`;
        if (!creators.has(key) || !label.startsWith('#'))
          creators.set(key, { id: key, label });
      }
      if (r.user_id != null) {
        const key = String(r.user_id),
          label = stripTelegramId(r.staff_name) || `#${r.user_id}`;
        if (!staff.has(key) || !label.startsWith('#'))
          staff.set(key, { id: key, label });
      }
    }
    const sorted = (m) =>
      [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'vi'));
    return {
      funds: await funds(),
      groups: sorted(groups),
      creators: sorted(creators),
      staff: sorted(staff),
      supportedFilters: {
        debt: false,
        partnerType: false,
        partnerCode: false,
        partnerName: true,
        partnerId: true,
        partnerPhone: true,
      },
    };
  }
  return { summary, entries, filterOptions, syncStatus };
}
module.exports = { createRepository, groupFunds, CASH_BOOK_TRANSACTIONS_SELECT };
