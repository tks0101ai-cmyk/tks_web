'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshRepository({ hn, sg, northSouth, northSouthError, pickupHn, pickupSg, pickupError, accounting, accountingError, historyRows, historyClientOverrides }) {
  const clientPath = require.resolve('../sheets/orderLifecycleSheetsClient');
  const historyClientPath = require.resolve('../sheets/orderLifecycleHistoryClient');
  const configPath = require.resolve('../config');
  const repoPath = require.resolve('./orderLifecycleRepository');
  const previousClient = require.cache[clientPath];
  const previousHistoryClient = require.cache[historyClientPath];

  const CONFIG = require(configPath);
  const values = {
    [CONFIG.ORDER_LIFECYCLE_SHEET_HN]: hn || [],
    [CONFIG.ORDER_LIFECYCLE_SHEET_SG]: sg || [],
    [CONFIG.ORDER_LIFECYCLE_SHEET_NORTH_SOUTH]: northSouth || [],
    [CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_HN]: pickupHn || [],
    [CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_SG]: pickupSg || [],
    [CONFIG.ORDER_LIFECYCLE_SHEET_ACCOUNTING]: accounting || []
  };

  const clientExports = {
    getValues: async sheetName => {
      if (northSouthError && sheetName === CONFIG.ORDER_LIFECYCLE_SHEET_NORTH_SOUTH) throw northSouthError;
      if (pickupError && sheetName === CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_HN) throw pickupError;
      if (accountingError && sheetName === CONFIG.ORDER_LIFECYCLE_SHEET_ACCOUNTING) throw accountingError;
      return values[sheetName] || [];
    }
  };

  const appendedRows = [];
  const historyClientExports = Object.assign({
    getValues: async () => historyRows || [],
    appendRow: async (sheetName, row) => { appendedRows.push({ sheetName, row }); }
  }, historyClientOverrides || {});

  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: clientExports
  };
  require.cache[historyClientPath] = {
    id: historyClientPath,
    filename: historyClientPath,
    loaded: true,
    exports: historyClientExports
  };
  delete require.cache[repoPath];
  const repo = require('./orderLifecycleRepository');

  return {
    repo,
    appendedRows,
    restore() {
      delete require.cache[repoPath];
      if (previousClient) require.cache[clientPath] = previousClient;
      else delete require.cache[clientPath];
      if (previousHistoryClient) require.cache[historyClientPath] = previousHistoryClient;
      else delete require.cache[historyClientPath];
    }
  };
}

const HEADERS = [
  'Mã đơn hàng', 'Nhân viên bán hàng', 'Khách hàng', 'Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn',
  'Lái xe', 'Tài xế gửi xác nhận giao hàng', 'Kế toán duyệt giao hàng', 'Xác nhận đã giao/khách ký nhận',
  'Ship nhận đơn', 'Đơn đã ký nhận'
];

test('SCHEMA_HEADERS/SCHEMA_FIELD_KEYS khớp đúng 11 cột theo sheet thật', () => {
  const ctx = freshRepository({});
  try {
    assert.deepEqual(ctx.repo.SCHEMA_HEADERS, HEADERS);
    assert.deepEqual(ctx.repo.SCHEMA_FIELD_KEYS, [
      'orderCode', 'saleName', 'customerName', 'saleSentAt', 'accountantApprovedOrderAt',
      'driverName', 'driverConfirmedDeliveryAt', 'accountantApprovedDeliveryAt', 'deliveryConfirmedAt',
      'shipReceivedAt', 'orderSignedAt'
    ]);
  } finally {
    ctx.restore();
  }
});

test('rowToObject ánh xạ đúng vị trí cột, thiếu cột trả rỗng', () => {
  const ctx = freshRepository({});
  try {
    const obj = ctx.repo.rowToObject(['HD001', 'Sale A', 'KH A'], ctx.repo.SCHEMA_FIELD_KEYS);
    assert.equal(obj.orderCode, 'HD001');
    assert.equal(obj.saleName, 'Sale A');
    assert.equal(obj.customerName, 'KH A');
    assert.equal(obj.saleSentAt, '');
    assert.equal(obj.deliveryConfirmedAt, '');
  } finally {
    ctx.restore();
  }
});

test('readAll đọc cả 2 tab, gộp lại và gắn đúng _branch', async () => {
  const ctx = freshRepository({
    hn: [HEADERS, ['HD001', 'Sale A', 'KH A', '01/09/2026', '', '', '', '', '', '', '']],
    sg: [HEADERS, ['HD002', 'Sale B', 'KH B', '02/09/2026', '', '', '', '', '', '', '']]
  });
  try {
    const rows = await ctx.repo.readAll();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].orderCode, 'HD001');
    assert.equal(rows[0]._branch, ctx.repo.LIFECYCLE_BRANCH.HN);
    assert.equal(rows[1].orderCode, 'HD002');
    assert.equal(rows[1]._branch, ctx.repo.LIFECYCLE_BRANCH.SG);
  } finally {
    ctx.restore();
  }
});

test('readAll bỏ hàng trống (mọi cột rỗng)', async () => {
  const ctx = freshRepository({
    hn: [HEADERS, ['HD001', 'Sale A', 'KH A', '', '', '', '', '', '', '', ''], ['', '', '', '', '', '', '', '', '', '', '']],
    sg: []
  });
  try {
    const rows = await ctx.repo.readAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orderCode, 'HD001');
  } finally {
    ctx.restore();
  }
});

test('readAll đọc đúng theo TÊN cột kể cả khi cột bị xóa/đảo vị trí trên sheet thật (bug 2026-09-14: tab SG mất cột "Xác nhận đã giao/khách ký nhận", lệch hết cột phía sau)', async () => {
  const SHIFTED_HEADERS_MISSING_DELIVERY_CONFIRMED = [
    'Mã đơn hàng', 'Nhân Viên Bán Hàng', 'Khách hàng', 'Sale gửi đơn cho kế toán', 'Kế toán duyệt',
    'Lái Xe', 'Tài xế gửi xác nhận giao hàng', 'Kế toán duyệt giao hàng',
    'Ship nhận đơn', 'Đơn đã ký nhận'
  ];
  const ctx = freshRepository({
    sg: [
      SHIFTED_HEADERS_MISSING_DELIVERY_CONFIRMED,
      ['HD000005', 'Dương', 'ANH PHONG HÀ ĐÔNG', '14/09/2026 15:22', '14/09/2026 15:22',
        'Tuấn Anh', '14/09/2026 15:20', '14/09/2026 15:21', '', '16/09/2026 15:21']
    ]
  });
  try {
    const rows = await ctx.repo.readAll();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.orderCode, 'HD000005');
    assert.equal(row.accountantApprovedOrderAt, '14/09/2026 15:22'); // alias "Kế toán duyệt"
    assert.equal(row.accountantApprovedDeliveryAt, '14/09/2026 15:21');
    assert.equal(row.deliveryConfirmedAt, ''); // cột đã bị xóa khỏi sheet -> rỗng, không đọc nhầm cột khác
    assert.equal(row.shipReceivedAt, ''); // cột "Ship nhận đơn" đúng vị trí thật, không bị lệch
    assert.equal(row.orderSignedAt, '16/09/2026 15:21'); // "Đơn đã ký nhận" đọc đúng dù đã dịch trái 1 cột
  } finally {
    ctx.restore();
  }
});

test('readAll trả mảng rỗng khi tab không có dữ liệu (chỉ header hoặc trống hẳn)', async () => {
  const ctx = freshRepository({ hn: [HEADERS], sg: [] });
  try {
    const rows = await ctx.repo.readAll();
    assert.deepEqual(rows, []);
  } finally {
    ctx.restore();
  }
});

// Header tab DonHang_MienNam (đơn Bắc-Nam) đúng như trên Google Sheet thật: không có cột "Xác nhận đã giao/khách ký nhận".
const NORTH_SOUTH_HEADERS = [
  'Mã đơn hàng', 'Nhân Viên Bán Hàng', 'Khách hàng', 'Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn',
  'Lái Xe', 'Tài xế gửi xác nhận giao hàng', 'Kế toán duyệt giao hàng', 'Ship nhận đơn', 'Đơn đã ký nhận'
];

test('readAll đọc tab Bắc-Nam: _branch HN, _flow NORTH_SOUTH, chỉ giữ 4 mốc, bỏ qua các cột lái xe/ship', async () => {
  const ctx = freshRepository({
    northSouth: [
      NORTH_SOUTH_HEADERS,
      ['DH043419', 'Quan Nguyen', 'KH Minh Long', '12/10/2026 08:52', '12/10/2026 09:10',
        'Tuấn Anh', '12/10/2026 10:00', '12/10/2026 10:05', '13/10/2026 08:00', '14/10/2026 08:00']
    ]
  });
  try {
    const rows = await ctx.repo.readAll();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row._branch, ctx.repo.LIFECYCLE_BRANCH.HN);
    assert.equal(row._flow, ctx.repo.FLOW_NORTH_SOUTH);
    assert.equal(ctx.repo.FLOW_NORTH_SOUTH, 'NORTH_SOUTH'); // service khai báo lại đúng giá trị này
    assert.equal(row.orderCode, 'DH043419');
    assert.equal(row.saleName, 'Quan Nguyen');
    assert.equal(row.customerName, 'KH Minh Long');
    assert.equal(row.saleSentAt, '12/10/2026 08:52');
    assert.equal(row.accountantApprovedOrderAt, '12/10/2026 09:10');
    assert.equal(row.orderSignedAt, '14/10/2026 08:00');
    ['driverName', 'driverConfirmedDeliveryAt', 'accountantApprovedDeliveryAt', 'deliveryConfirmedAt', 'shipReceivedAt']
      .forEach(key => assert.equal(row[key], '', `${key} phải bị bỏ qua`));
  } finally {
    ctx.restore();
  }
});

test('readAll tab Bắc-Nam đọc theo TÊN header khi cột bị đảo vị trí', async () => {
  const ctx = freshRepository({
    northSouth: [
      ['Đơn đã ký nhận', 'Mã đơn hàng', 'Kế toán duyệt đơn', 'Sale gửi đơn cho kế toán'],
      ['13/10/2026 08:00', 'DH000001', '12/10/2026 09:10', '12/10/2026 08:52']
    ]
  });
  try {
    const [row] = await ctx.repo.readAll();
    assert.equal(row.orderCode, 'DH000001');
    assert.equal(row.saleSentAt, '12/10/2026 08:52');
    assert.equal(row.accountantApprovedOrderAt, '12/10/2026 09:10');
    assert.equal(row.orderSignedAt, '13/10/2026 08:00');
    assert.equal(row.saleName, '');
  } finally {
    ctx.restore();
  }
});

test('readAll nối theo thứ tự HN -> Bắc-Nam -> Khách_HN -> SG -> Khách_SG, mỗi dòng mang _flow', async () => {
  const ctx = freshRepository({
    hn: [HEADERS, ['HD001', '', '', '01/09/2026', '', '', '', '', '', '', '']],
    northSouth: [NORTH_SOUTH_HEADERS, ['DH002', '', '', '02/09/2026', '', '', '', '', '', '']],
    pickupHn: [PICKUP_HEADERS, ['KH004', '', '', '04/09/2026', '', '', '', '', '', '']],
    sg: [HEADERS, ['HD003', '', '', '03/09/2026', '', '', '', '', '', '', '']],
    pickupSg: [PICKUP_HEADERS, ['KH005', '', '', '05/09/2026', '', '', '', '', '', '']]
  });
  try {
    const rows = await ctx.repo.readAll();
    assert.deepEqual(rows.map(r => [r.orderCode, r._branch, r._flow]), [
      ['HD001', 'HN', 'DELIVERY'], ['DH002', 'HN', 'NORTH_SOUTH'], ['KH004', 'HN', 'PICKUP'],
      ['HD003', 'SG', 'DELIVERY'], ['KH005', 'SG', 'PICKUP']
    ]);
  } finally {
    ctx.restore();
  }
});

test('readAll: tab Bắc-Nam lỗi (đổi tên/xóa) -> fail-soft, vẫn trả HN + SG và ghi console.error', async () => {
  const ctx = freshRepository({
    hn: [HEADERS, ['HD001', '', '', '01/09/2026', '', '', '', '', '', '', '']],
    sg: [HEADERS, ['HD003', '', '', '03/09/2026', '', '', '', '', '', '', '']],
    northSouthError: new Error("Unable to parse range: 'DonHang_MienNam'")
  });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const rows = await ctx.repo.readAll();
    assert.deepEqual(rows.map(r => r.orderCode), ['HD001', 'HD003']);
    assert.ok(logged.some(line => line.includes('DonHang_MienNam')));
  } finally {
    console.error = originalError;
    ctx.restore();
  }
});

const HISTORY_HEADERS = [
  'Mã lịch sử', 'Mã đơn hàng', 'Mã trạng thái', 'Trạng thái mới',
  'Người thực hiện', 'Vai trò', 'Thời gian cập nhật', 'Ghi chú', 'Nội dung cập nhật'
];

test('readOverrideHistory: đọc và ánh xạ đúng cột tab "Lịch sử cập nhật"', async () => {
  const ctx = freshRepository({
    historyRows: [
      HISTORY_HEADERS,
      ['OVR-1', 'HD001', 'DELIVERING', 'Đơn đang được giao', 'Nguyễn Văn A', 'Kế toán', '2026-09-12 09:00:00', '', 'Nguyễn Văn A - Kế toán đã cập nhật đơn hàng sang trạng thái Đơn đang được giao.']
    ]
  });
  try {
    const rows = await ctx.repo.readOverrideHistory();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order_code, 'HD001');
    assert.equal(rows[0].to_status_code, 'DELIVERING');
    assert.equal(rows[0].changed_by_role, 'Kế toán');
  } finally {
    ctx.restore();
  }
});

test('readOverrideHistory: tab "Lịch sử cập nhật" chưa tồn tại (BRANCH_NOT_CONFIGURED) -> mảng rỗng, không throw', async () => {
  const ctx = freshRepository({
    historyClientOverrides: {
      getValues: async () => { const err = new Error('chưa cấu hình'); err.code = 'BRANCH_NOT_CONFIGURED'; throw err; }
    }
  });
  try {
    const rows = await ctx.repo.readOverrideHistory();
    assert.deepEqual(rows, []);
  } finally {
    ctx.restore();
  }
});

test('readOverrideHistory: lỗi bất kỳ khác (vd tab chưa được setup script tạo, thiếu quyền Editor) -> mảng rỗng, KHÔNG throw', async () => {
  const ctx = freshRepository({
    historyClientOverrides: {
      getValues: async () => { throw new Error('Unable to parse range: \'Lịch sử cập nhật\'!A:Z'); }
    }
  });
  try {
    const rows = await ctx.repo.readOverrideHistory();
    assert.deepEqual(rows, []);
  } finally {
    ctx.restore();
  }
});

test('appendOverride: ghi đúng thứ tự cột theo HISTORY_SCHEMA_FIELD_KEYS', async () => {
  const ctx = freshRepository({});
  try {
    const entry = await ctx.repo.appendOverride({
      order_code: 'HD001',
      to_status_code: 'CANCELLED',
      to_status_label: 'Đã hủy',
      changed_by: 'Nguyễn Văn A',
      changed_by_role: 'Quản lý',
      note: 'khách huỷ đơn',
      message: 'Nguyễn Văn A - Quản lý đã cập nhật đơn hàng sang trạng thái Đã hủy.'
    });
    assert.equal(ctx.appendedRows.length, 1);
    const row = ctx.appendedRows[0].row;
    assert.equal(row[ctx.repo.HISTORY_SCHEMA_FIELD_KEYS.indexOf('order_code')], 'HD001');
    assert.equal(row[ctx.repo.HISTORY_SCHEMA_FIELD_KEYS.indexOf('to_status_code')], 'CANCELLED');
    assert.ok(entry.history_id);
    assert.ok(entry.changed_at);
  } finally {
    ctx.restore();
  }
});

// Header tab Khách_HN/Khách_SG (2026-10-12) giống DonHang_MienNam: chỉ đọc Mã đơn, Sale gửi KT, KT duyệt, Ship nhận đơn.
const PICKUP_HEADERS = NORTH_SOUTH_HEADERS;

test('readAll đọc tab Khách_HN/SG: chỉ giữ Mã đơn / Sale gửi KT / KT duyệt / Lái xe (Kho) / Ship nhận đơn', async () => {
  const ctx = freshRepository({
    pickupSg: [
      PICKUP_HEADERS,
      ['DH000010', 'Sale A', 'KH B', '12/10/2026 08:52', '12/10/2026 09:10',
        'Tuấn Anh', '12/10/2026 10:00', '12/10/2026 10:05', '13/10/2026 08:00', '14/10/2026 08:00']
    ]
  });
  try {
    const [row] = await ctx.repo.readAll();
    assert.equal(row._branch, 'SG');
    assert.equal(row._flow, ctx.repo.FLOW_PICKUP);
    assert.equal(row.saleSentAt, '12/10/2026 08:52');
    assert.equal(row.accountantApprovedOrderAt, '12/10/2026 09:10');
    assert.equal(row.shipReceivedAt, '13/10/2026 08:00');
    assert.equal(row.driverName, 'Tuấn Anh', 'cột Lái xe là bước Kho của luồng khách/ship lấy');
    ['driverConfirmedDeliveryAt', 'accountantApprovedDeliveryAt', 'deliveryConfirmedAt', 'orderSignedAt']
      .forEach(key => assert.equal(row[key], '', `${key} phải bị bỏ qua`));
  } finally {
    ctx.restore();
  }
});

test('readAll DonHang_HN/SG: bỏ qua cột "Ship nhận đơn" (luồng ship/khách đã tách tab)', async () => {
  const ctx = freshRepository({ hn: [HEADERS, ['HD001', '', '', '01/09/2026', '', '', '', '', '', '02/09/2026', '']] });
  try {
    const [row] = await ctx.repo.readAll();
    assert.equal(row._flow, ctx.repo.FLOW_DELIVERY);
    assert.equal(row.shipReceivedAt, '');
  } finally {
    ctx.restore();
  }
});

test('readAll đọc tab KeToan_ChungTu: _flow ACCOUNTING, không có cơ sở, đọc theo TÊN header, bỏ dòng thiếu mã', async () => {
  const ctx = freshRepository({
    accounting: [
      ['Thời gian gửi', 'Mã đơn hàng', 'Người gửi (kế toán)'],
      ['14/10/2026 10:30', 'DH043419', 'Kế toán Lan'],
      ['14/10/2026 11:00', '', 'Kế toán Hoa']
    ]
  });
  try {
    const rows = await ctx.repo.readAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._flow, ctx.repo.FLOW_ACCOUNTING);
    assert.equal(ctx.repo.FLOW_ACCOUNTING, 'ACCOUNTING'); // service khai báo lại đúng giá trị này
    assert.equal(rows[0]._branch, null);
    assert.equal(rows[0].orderCode, 'DH043419');
    assert.equal(rows[0].accountingSender, 'Kế toán Lan');
    assert.equal(rows[0].saleSentAt, '14/10/2026 10:30');
  } finally {
    ctx.restore();
  }
});

test('readAll: tab KeToan_ChungTu lỗi -> fail-soft, các tab khác vẫn đọc', async () => {
  const ctx = freshRepository({
    hn: [HEADERS, ['HD001', '', '', '01/09/2026', '', '', '', '', '', '', '']],
    accountingError: new Error("Unable to parse range: 'KeToan_ChungTu'")
  });
  const realError = console.error;
  const logged = [];
  console.error = line => logged.push(String(line));
  try {
    const rows = await ctx.repo.readAll();
    assert.deepEqual(rows.map(r => r.orderCode), ['HD001']);
    assert.ok(logged.some(line => line.includes('KeToan_ChungTu')));
  } finally {
    console.error = realError;
    ctx.restore();
  }
});

test('readAll: tab Khách_HN lỗi -> fail-soft, các tab khác vẫn đọc', async () => {
  const ctx = freshRepository({
    hn: [HEADERS, ['HD001', '', '', '01/09/2026', '', '', '', '', '', '', '']],
    pickupError: new Error("Unable to parse range: 'Khách_HN'")
  });
  const realError = console.error;
  const logged = [];
  console.error = line => logged.push(String(line));
  try {
    const rows = await ctx.repo.readAll();
    assert.deepEqual(rows.map(r => r.orderCode), ['HD001']);
    assert.ok(logged.some(line => line.includes('Khách_HN')));
  } finally {
    console.error = realError;
    ctx.restore();
  }
});

test('readAll: tab mất tiêu đề "Mã đơn hàng" (ô A1 trống, bug 11/11/2026 ở DonHang_SG) vẫn đọc mã đơn ở cột A; cột A mang tiêu đề khác thì không đoán', async t => {
  t.mock.method(console, 'warn', () => {});
  const header = ['', 'Nhân Viên Bán Hàng', 'Khách hàng', 'Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn', 'Lái Xe',
    'Tài xế gửi xác nhận giao hàng', 'Kế toán duyệt giao hàng', 'Ship nhận đơn', 'Đơn đã ký nhận'];
  const row = ['DH022860', 'NGUYỄN THỊ LỆ', 'NN QHI Campuchia', '11/11/2026 09:41', '11/11/2026 09:45', 'Phan Thành Bảy',
    '11/11/2026 14:15', '11/11/2026 14:51', '', '11/11/2026 15:48'];
  const ctx = freshRepository({ sg: [header, row], hn: [['Khách hàng', 'Sale gửi đơn cho kế toán'], ['KH A', '11/11/2026 08:00']] });
  try {
    const records = await ctx.repo.readAll();
    const sg = records.find(r => r._branch === 'SG');
    assert.equal(sg.orderCode, 'DH022860');
    assert.equal(sg.orderSignedAt, '11/11/2026 15:48');
    assert.equal(records.find(r => r._branch === 'HN').orderCode, '', 'cột A là "Khách hàng": không lấy làm mã đơn');
  } finally { ctx.restore(); }
});
