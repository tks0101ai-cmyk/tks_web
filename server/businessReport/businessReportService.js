'use strict';

// Gom so lieu Bao cao kinh doanh tu snapshot cua repository (ham thuan, khong I/O):
// dong Sale / Khach / Ma hang voi chuoi doanh so theo thang, quy doi 30 ngay, tang
// truong, TB 4 thang, co "hoat dong"; chi so tong quat; du lieu panel chi tiet.
// Khach duoc GOP THEO TEN (HN + SG, nhieu ma); sale co them team (bang sale_teams).

const { UNGROUPED_SALE, NO_TEAM, RETAIL_NAME, DEFAULT_PRICE_LEVEL, nameKey, buildMetrics, monthLabel, addMonths } = require('./businessMonths');

function notFound(message) {
  const e = new Error(message);
  e.statusCode = 404;
  return e;
}

function withMetrics(row, series, snap) {
  const m = buildMetrics(series, snap.currentMonth, snap.day);
  return { ...row, series, ...m, active: m.avg4 > 0 };
}

function header(snap) {
  return {
    notReady: !!snap.notReady, today: snap.today, currentMonth: snap.currentMonth, day: snap.day, months: snap.months,
    monthLabels: snap.months.map(monthLabel), frozenMonths: snap.frozenMonths, computedAt: snap.computedAt
  };
}

function directoryIndex(snap) {
  const map = new Map();
  for (const d of snap.directory) map.set(`${d.branch}:${d.code}`, d);
  return map;
}

function teamIndex(snap) {
  const index = new Map();
  for (const t of snap.teams || []) index.set(nameKey(t.saleName), { saleName: t.saleName, team: t.teamName });
  return index;
}

// Ten nhom khach -> ten sale chuan (theo sale_teams, gop khac hoa/thuong); khong co thi giu nguyen.
function canonicalSale(name, teams) {
  const t = teams.get(nameKey(name));
  return t ? t.saleName : name;
}

// Ho so khach theo (co so, ma KH), gan san sale chuan; chua gop theo ten.
function customerRecords(snap) {
  const dir = directoryIndex(snap);
  const teams = teamIndex(snap);
  const groups = new Map();
  for (const r of snap.customers) {
    const key = `${r.branch}:${r.customerCode}`;
    let g = groups.get(key);
    if (!g) {
      const d = dir.get(key);
      g = {
        row: {
          branch: r.branch, code: r.customerCode,
          name: (d && d.name) || r.customerName || RETAIL_NAME,
          saleName: canonicalSale((r.customerCode && d && d.saleName) || UNGROUPED_SALE, teams),
          priceLevel: (d && d.priceLevel) || DEFAULT_PRICE_LEVEL
        },
        series: {}
      };
      groups.set(key, g);
    }
    g.series[r.month] = (g.series[r.month] || 0) + Number(r.netRevenue || 0);
  }
  return [...groups.values()].map(g => withMetrics(g.row, g.series, snap));
}

const seriesTotal = series => Object.values(series).reduce((s, v) => s + v, 0);
const byTotalDesc = (a, b) => seriesTotal(b.series) - seriesTotal(a.series);

// Gop cac ho so cung ten (HN + SG, nhieu ma) thanh 1 khach. Sale = sale co TB 4 thang (cua so
// 4 thang) lon nhat; khong ai co doanh so trong cua so thi lay sale cua ho so tong lon nhat.
// Legacy selection preserved during one-time initialization; live routes overlay local levels.
// Pick the highest-revenue record with a non-default level, else Vừa.
function levelOf(recs) {
  const set = recs.slice().sort(byTotalDesc).find(rec => rec.priceLevel && rec.priceLevel !== DEFAULT_PRICE_LEVEL);
  return set ? set.priceLevel : DEFAULT_PRICE_LEVEL;
}

function mergeByName(records, snap) {
  const groups = new Map();
  for (const rec of records) {
    const key = nameKey(rec.name) || nameKey(RETAIL_NAME);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  return [...groups.entries()].map(([key, recs]) => {
    const main = recs.slice().sort(byTotalDesc)[0];
    const series = {};
    for (const rec of recs) for (const [month, value] of Object.entries(rec.series)) series[month] = (series[month] || 0) + value;
    const window = new Map();
    for (const rec of recs) window.set(rec.saleName, (window.get(rec.saleName) || 0) + rec.avg4);
    const best = [...window.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return withMetrics({
      key, name: main.name, saleName: best[1] > 0 ? best[0] : main.saleName, priceLevel: levelOf(recs),
      refs: recs.map(rec => ({ branch: rec.branch, code: rec.code }))
    }, series, snap);
  });
}

function customerRows(snap) {
  return mergeByName(customerRecords(snap), snap);
}

function sortByAvg4(rows) {
  return rows.sort((a, b) => b.avg4 - a.avg4 || b.current - a.current);
}

function buildCustomerReport(snap) {
  return { ...header(snap), rows: sortByAvg4(customerRows(snap)) };
}

function buildSaleReport(snap) {
  const teams = teamIndex(snap);
  const sales = new Map();
  const ensure = name => {
    const saleName = canonicalSale(name, teams);
    if (!sales.has(saleName)) sales.set(saleName, { saleName, series: {}, activeCustomers: 0 });
    return sales.get(saleName);
  };
  const add = (sale, month, value) => { sale.series[month] = (sale.series[month] || 0) + value; };
  const frozen = new Set(snap.frozenMonths);
  // Thang da chot: doc bang sale (dung lai theo nhom hien tai boi job).
  for (const r of snap.sales) {
    if (frozen.has(r.month)) add(ensure(r.saleName), r.month, Number(r.netRevenue) || 0);
  }
  // Thang chua chot (gom thang hien tai): gom tu ho so khach THEO NHOM GOC (chua gop theo ten).
  const records = customerRecords(snap);
  for (const c of records) {
    const s = ensure(c.saleName);
    for (const [month, value] of Object.entries(c.series)) {
      if (!frozen.has(month)) add(s, month, value);
    }
  }
  // SL khach = so khach da gop dang hoat dong ma sale duoc gan la sale nay.
  for (const c of mergeByName(records, snap)) {
    if (c.active) ensure(c.saleName).activeCustomers += 1;
  }
  const rows = sortByAvg4([...sales.values()].map(s => withMetrics({
    key: s.saleName, saleName: s.saleName, team: (teams.get(nameKey(s.saleName)) || {}).team || NO_TEAM, activeCustomers: s.activeCustomers
  }, s.series, snap)));
  const teamNames = [...new Set(rows.map(r => r.team))].sort((a, b) => a.localeCompare(b, 'vi'));
  return { ...header(snap), teams: teamNames, rows };
}

function buildProductReport(snap) {
  const groups = new Map();
  for (const r of snap.products) {
    let g = groups.get(r.productCode);
    if (!g) { g = { row: { key: r.productCode, code: r.productCode, name: r.productName || '' }, series: {} }; groups.set(r.productCode, g); }
    if (r.productName) g.row.name = r.productName;
    g.series[r.month] = (g.series[r.month] || 0) + Number(r.netRevenue || 0);
  }
  return { ...header(snap), rows: sortByAvg4([...groups.values()].map(g => withMetrics(g.row, g.series, snap))) };
}

// Chi so tong quat (muc 1): toan cong ty, cong tat ca dong cua bang Sale (gom ca "Chua phan nhom").
function buildOverview(snap) {
  const saleRows = buildSaleReport(snap).rows;
  const total = key => saleRows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const prev = total('prev');
  return {
    ...header(snap),
    kpis: [
      { key: 'growth', label: 'Tăng trưởng', value: prev > 0 ? total('normalized') / prev * 100 : null, type: 'percent' },
      { key: 'avg4', label: 'TB 4 tháng', value: total('avg4'), type: 'money' },
      { key: 'current', label: `Doanh số tháng này (đến ${snap.today.slice(8, 10)}/${snap.today.slice(5, 7)})`, value: total('current'), type: 'money' },
      { key: 'saleCount', label: 'SL Sale', value: saleRows.filter(r => r.active && r.saleName !== UNGROUPED_SALE).length, type: 'number' },
      { key: 'activeCustomers', label: 'SL Khách hoạt động', value: customerRows(snap).filter(r => r.active).length, type: 'number' },
      { key: 'activeProducts', label: 'SL Mã hoạt động', value: buildProductReport(snap).rows.filter(r => r.active).length, type: 'number' }
    ]
  };
}

function last4Months(snap) {
  return [3, 2, 1, 0].map(i => addMonths(snap.currentMonth, -i));
}

function detailBase(row, snap, title, subtitle) {
  return {
    ...header(snap), title, subtitle,
    summary: [
      { key: 'current', label: 'Tháng này', value: row.current, type: 'money' },
      { key: 'normalized', label: 'Quy đổi 30 ngày', value: row.normalized, type: 'money' },
      { key: 'prev', label: 'Tháng trước', value: row.prev, type: 'money' },
      { key: 'growth', label: 'Tăng trưởng', value: row.growth, type: 'percent' },
      { key: 'avg4', label: 'TB 4 tháng', value: row.avg4, type: 'money' },
      { key: 'total', label: 'Tổng từ T3/26', value: Object.values(row.series).reduce((s, v) => s + v, 0), type: 'money' }
    ],
    chart: snap.months.map(m => ({ month: m, label: monthLabel(m), value: row.series[m] || 0, partial: m === snap.currentMonth }))
  };
}

// extra.topProducts / extra.topCustomers do routes nap qua repository (4 thang gan nhat).
function buildDetail(kind, key, snap, extra = {}) {
  if (kind === 'sale') {
    const report = buildSaleReport(snap);
    const row = report.rows.find(r => r.key === key);
    if (!row) throw notFound('Không tìm thấy sale này.');
    const customers = buildCustomerReport(snap).rows.filter(c => c.saleName === key);
    const base = detailBase(row, snap, key, `${row.team} · ${row.activeCustomers} khách hoạt động`);
    base.summary.push({ key: 'activeCustomers', label: 'SL khách hoạt động', value: row.activeCustomers, type: 'number' });
    return { ...base, kind, customers };
  }
  if (kind === 'customer') {
    const row = buildCustomerReport(snap).rows.find(r => r.key === key);
    if (!row) throw notFound('Không tìm thấy khách hàng này.');
    return { ...detailBase(row, snap, row.name, `Sale ${row.saleName}`),
      kind, customer: row, topProducts: extra.topProducts || [], window: last4Months(snap) };
  }
  if (kind === 'product') {
    const row = buildProductReport(snap).rows.find(r => r.key === key);
    if (!row) throw notFound('Không tìm thấy mã hàng này.');
    return { ...detailBase(row, snap, `${row.code} – ${row.name}`, 'Doanh số theo tháng'),
      kind, product: row, topCustomers: extra.topCustomers || [], window: last4Months(snap) };
  }
  const e = new Error('Loại chi tiết không hợp lệ.');
  e.statusCode = 400;
  throw e;
}

module.exports = { buildOverview, buildSaleReport, buildCustomerReport, buildProductReport, buildDetail, last4Months, customerRecords };
