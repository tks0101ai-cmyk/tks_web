'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshService(rows, historyRows) {
  const repoPath = require.resolve('./orderLifecycleRepository');
  const servicePath = require.resolve('./orderLifecycleService');
  const previousRepo = require.cache[repoPath];

  const appended = [];
  const repoExports = {
    readAll: async () => rows,
    readOverrideHistory: async () => historyRows || [],
    appendOverride: async (entry) => {
      const full = Object.assign({ history_id: 'OVR-TEST', changed_at: '2026-09-12 10:00:00' }, entry);
      appended.push(full);
      return full;
    }
  };

  require.cache[repoPath] = {
    id: repoPath,
    filename: repoPath,
    loaded: true,
    exports: repoExports
  };
  delete require.cache[servicePath];
  const service = require('./orderLifecycleService');

  return {
    service,
    appended,
    restore() {
      delete require.cache[servicePath];
      if (previousRepo) require.cache[repoPath] = previousRepo;
      else delete require.cache[repoPath];
    }
  };
}

function overrideRow(overrides) {
  return Object.assign({
    history_id: 'OVR-1',
    order_code: 'HD001',
    to_status_code: 'DELIVERING',
    to_status_label: 'Đơn đang được giao',
    changed_by: 'Nguyễn Văn A',
    changed_by_role: 'Kế toán',
    changed_at: '2026-09-12 09:00:00',
    note: '',
    message: 'Nguyễn Văn A - Kế toán đã cập nhật đơn hàng sang trạng thái Đơn đang được giao.',
    from_status_code: '',
    from_status_label: ''
  }, overrides);
}

function record(overrides) {
  return Object.assign({
    orderCode: 'HD001',
    saleName: '',
    customerName: '',
    saleSentAt: '',
    accountantApprovedOrderAt: '',
    driverName: '',
    driverConfirmedDeliveryAt: '',
    accountantApprovedDeliveryAt: '',
    deliveryConfirmedAt: '',
    shipReceivedAt: '',
    orderSignedAt: '',
    _branch: 'HN'
  }, overrides);
}

test('computeStatus: không có gì -> NOT_SENT (Đơn chưa gửi kế toán)', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({}));
    assert.equal(status.code, ctx.service.STATUS.NOT_SENT);
    assert.equal(status.label, 'Đơn chưa gửi kế toán');
    assert.equal(status.at, null);
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột C có giá trị, F trống -> SENT_TO_ACCOUNTANT kèm sale + thời gian', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({ saleName: 'Sale A', saleSentAt: '01/09/2026 08:00' }));
    assert.equal(status.code, ctx.service.STATUS.SENT_TO_ACCOUNTANT);
    assert.equal(status.label, 'Đơn đã gửi kế toán');
    assert.equal(status.actor, 'Sale A');
    assert.equal(status.at, '01/09/2026 08:00');
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột F có giá trị, H trống -> DELIVERING kèm lái xe + thời gian', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({
      saleName: 'Sale A', saleSentAt: '01/09/2026 08:00',
      driverName: 'Lái xe B', driverConfirmedDeliveryAt: '02/09/2026 09:00'
    }));
    assert.equal(status.code, ctx.service.STATUS.DELIVERING);
    assert.equal(status.label, 'Đơn đang được giao');
    assert.equal(status.actor, 'Lái xe B');
    assert.equal(status.at, '02/09/2026 09:00');
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột H có giá trị -> KHÔNG đổi trạng thái (vẫn DELIVERING), chi tiết vẫn giữ giá trị H', () => {
  const ctx = freshService([]);
  try {
    const rec = record({
      saleSentAt: '01/09/2026', driverConfirmedDeliveryAt: '02/09/2026',
      deliveryConfirmedAt: '03/09/2026 10:00'
    });
    const status = ctx.service.computeStatus(rec);
    assert.equal(status.code, ctx.service.STATUS.DELIVERING);
    assert.equal(status.at, '02/09/2026');
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột Ship nhận đơn có giá trị -> SHIP_RECEIVED (trạng thái cuối cùng)', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({
      saleSentAt: '01/09/2026', driverConfirmedDeliveryAt: '02/09/2026',
      deliveryConfirmedAt: '03/09/2026 10:00', shipReceivedAt: '04/09/2026 08:00'
    }));
    assert.equal(status.code, ctx.service.STATUS.SHIP_RECEIVED);
    assert.equal(status.label, 'Đã nhận (Tại kho)');
    assert.equal(status.at, '04/09/2026 08:00');
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột Ship nhận đơn ưu tiên cao hơn cột H (Xác nhận đã giao)', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({
      deliveryConfirmedAt: '03/09/2026 10:00', shipReceivedAt: '04/09/2026 08:00'
    }));
    assert.equal(status.code, ctx.service.STATUS.SHIP_RECEIVED);
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột Đơn đã ký nhận có giá trị -> SIGNED (trạng thái cuối cùng)', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({
      saleSentAt: '01/09/2026', driverConfirmedDeliveryAt: '02/09/2026',
      deliveryConfirmedAt: '03/09/2026 10:00', shipReceivedAt: '04/09/2026 08:00',
      orderSignedAt: '05/09/2026 09:00'
    }));
    assert.equal(status.code, ctx.service.STATUS.SIGNED);
    assert.equal(status.label, 'Đã nhận (Đi giao xong)');
    assert.equal(status.at, '05/09/2026 09:00');
  } finally {
    ctx.restore();
  }
});

test('computeStatus: cột Đơn đã ký nhận ưu tiên cao hơn cột Ship nhận đơn', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({
      shipReceivedAt: '04/09/2026 08:00', orderSignedAt: '05/09/2026 09:00'
    }));
    assert.equal(status.code, ctx.service.STATUS.SIGNED);
  } finally {
    ctx.restore();
  }
});

test('computeStatus edge case: D có giá trị nhưng C trống -> vẫn NOT_SENT (không đọc D)', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({ accountantApprovedOrderAt: '01/09/2026' }));
    assert.equal(status.code, ctx.service.STATUS.NOT_SENT);
  } finally {
    ctx.restore();
  }
});

test('computeStatus edge case: G có giá trị nhưng F trống -> vẫn SENT_TO_ACCOUNTANT (không đọc G)', () => {
  const ctx = freshService([]);
  try {
    const status = ctx.service.computeStatus(record({
      saleName: 'Sale A', saleSentAt: '01/09/2026',
      accountantApprovedDeliveryAt: '02/09/2026'
    }));
    assert.equal(status.code, ctx.service.STATUS.SENT_TO_ACCOUNTANT);
  } finally {
    ctx.restore();
  }
});

test('findOrder: mã không tồn tại trong sheet -> found:false, summary NOT_SENT', async () => {
  const ctx = freshService([record({ orderCode: 'HD001', saleSentAt: '01/09/2026' })]);
  try {
    const result = await ctx.service.findOrder('HD999');
    assert.equal(result.found, false);
    assert.equal(result.summary.code, ctx.service.STATUS.NOT_SENT);
    assert.equal(result.detail, undefined);
  } finally {
    ctx.restore();
  }
});

test('findOrder: mã rỗng -> found:false, không gọi readAll thất bại', async () => {
  const ctx = freshService([record({})]);
  try {
    const result = await ctx.service.findOrder('   ');
    assert.equal(result.found, false);
  } finally {
    ctx.restore();
  }
});

test('findOrder: khớp mã không phân biệt hoa/thường và khoảng trắng, trả đủ chi tiết + branch', async () => {
  const ctx = freshService([record({
    orderCode: 'HD001', saleName: 'Sale A', saleSentAt: '01/09/2026', _branch: 'SG'
  })]);
  try {
    const result = await ctx.service.findOrder('  hd001  ');
    assert.equal(result.found, true);
    assert.equal(result.branch, 'SG');
    assert.equal(result.summary.code, ctx.service.STATUS.SENT_TO_ACCOUNTANT);
    assert.equal(result.detail.orderCode, 'HD001');
    assert.equal(result.detail.saleName, 'Sale A');
  } finally {
    ctx.restore();
  }
});

test('findOrder + queryOrders trả `flow` của dòng sheet (mặc định DELIVERY khi dòng không mang _flow)', async () => {
  const ctx = freshService([
    record({ orderCode: 'HD001', saleSentAt: '01/09/2026' }),
    record({ orderCode: 'HD002', saleSentAt: '01/09/2026', _flow: 'NORTH_SOUTH' }),
    record({ orderCode: 'HD003', saleSentAt: '01/09/2026', _flow: 'PICKUP' })
  ]);
  try {
    assert.equal((await ctx.service.findOrder('HD001')).flow, 'DELIVERY');
    assert.equal((await ctx.service.findOrder('HD002')).flow, 'NORTH_SOUTH');
    assert.equal((await ctx.service.findOrder('HD003')).flow, 'PICKUP');
    const { orders } = await ctx.service.queryOrders({ pageSize: '10' });
    const flowByCode = Object.fromEntries(orders.map(o => [o.orderCode, o.flow]));
    assert.deepEqual(flowByCode, { HD001: 'DELIVERY', HD002: 'NORTH_SOUTH', HD003: 'PICKUP' });
  } finally {
    ctx.restore();
  }
});

test('listAllOrders: lọc theo branch và giữ nguyên thứ tự hàng trong sheet', async () => {
  const ctx = freshService([
    record({ orderCode: 'HD001', _branch: 'HN' }),
    record({ orderCode: 'HD002', _branch: 'SG' }),
    record({ orderCode: 'HD003', _branch: 'HN' })
  ]);
  try {
    const all = await ctx.service.listAllOrders();
    assert.deepEqual(all.map(o => o.orderCode), ['HD001', 'HD002', 'HD003']);

    const hnOnly = await ctx.service.listAllOrders('HN');
    assert.deepEqual(hnOnly.map(o => o.orderCode), ['HD001', 'HD003']);
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// GOP don cua Kiot (2026-10-01; MOI trang thai tu 2026-10-02): khoa (co so, ma don), sheet thang khi trung,
// don chi co o Kiot -> NOT_SENT; lookup/ghi de van chi doc sheet. Bang tra ve THEO TRANG (queryOrders).
// ---------------------------------------------------------------------------

function kiotOrder(overrides) {
  return Object.assign({
    branch: 'HN', code: 'DH041173', customerName: 'KH Kiot', saleName: 'Nguyễn Văn A',
    orderDate: '01/10/2026 13:14', total: 8091000, kiotStatus: 'Phiếu tạm', note: 'Giao sớm', sellableValue: 6000000
  }, overrides);
}

function fakeKiot(result) {
  const calls = { reads: 0 };
  return {
    calls,
    readOrders: async () => { calls.reads++; return result; }
  };
}

test('queryOrders: dòng sheet thắng khi trùng (cơ sở, mã); đơn Kiot khớp được gắn trạng thái/ghi chú/giá trị, không nhân đôi; dòng sheet không có trên Kiot bị bỏ', async () => {
  const ctx = freshService([
    record({ orderCode: 'DH041173', _branch: 'HN', saleName: 'Sale Sheet', saleSentAt: '01/10/2026 08:00', driverConfirmedDeliveryAt: '01/10/2026 09:00' }),
    record({ orderCode: 'DH000999', _branch: 'HN' })
  ]);
  try {
    const { orders, kiot, total, filteredTotal } = await ctx.service.queryOrders({}, {
      kiot: fakeKiot({ ok: true, stale: false, fetchedAt: '2026-10-01T06:00:00.000Z', orders: [kiotOrder()] })
    });
    assert.equal(orders.length, 1, 'khong them dong trung; don sheet khong co tren Kiot (DH000999) bi bo khoi bang');
    assert.equal(orders.some(o => o.orderCode === 'DH000999'), false);
    assert.deepEqual([total, filteredTotal], [1, 1]);
    const matched = orders.find(o => o.orderCode === 'DH041173');
    assert.equal(matched.source, 'sheet');
    assert.equal(matched.summary.code, 'DELIVERING', 'trang thai theo moc trong sheet, khong bi Kiot ghi de');
    assert.equal(matched.saleName, 'Nguyễn Văn A', 'ten sale theo don Kiot, khong theo sheet');
    assert.equal(matched.customerName, 'KH Kiot', 'khach hang theo don Kiot');
    assert.equal(matched.kiotStatus, 'Phiếu tạm');
    assert.equal(matched.note, 'Giao sớm');
    assert.equal(matched.sellableValue, 6000000);
    assert.equal(matched.orderTotal, 8091000);
    assert.equal(matched.orderDate, '01/10/2026 13:14');
    assert.deepEqual(kiot, { ok: true, stale: false, fetchedAt: '2026-10-01T06:00:00.000Z', count: 1 });
  } finally {
    ctx.restore();
  }
});

test('queryOrders: lấy MỌI trạng thái Kiot (Phiếu tạm, Hoàn thành, Đã hủy...) — chỉ đơn Phiếu tạm có giá trị có bán; danh sách trạng thái Kiot trả về cho ô lọc', async () => {
  const ctx = freshService([]);
  try {
    const result = await ctx.service.queryOrders({}, { kiot: fakeKiot({ ok: true, orders: [
      kiotOrder({ code: 'DH3', orderDate: '03/10/2026 10:00', kiotStatus: 'Hoàn thành', sellableValue: null, note: '' }),
      kiotOrder({ code: 'DH2', orderDate: '02/10/2026 10:00', kiotStatus: 'Đã hủy', sellableValue: null }),
      kiotOrder({ code: 'DH1', orderDate: '01/10/2026 10:00', kiotStatus: 'Phiếu tạm' })
    ] }) });
    assert.deepEqual(result.orders.map(o => [o.orderCode, o.kiotStatus, o.sellableValue]), [
      ['DH3', 'Hoàn thành', null], ['DH2', 'Đã hủy', null], ['DH1', 'Phiếu tạm', 6000000]
    ]);
    assert.deepEqual(result.kiotStatuses, ['Phiếu tạm', 'Hoàn thành', 'Đã hủy']);
    assert.equal(result.orders[0].orderTotal, 8091000, 'gia tri don co voi moi don Kiot');
  } finally {
    ctx.restore();
  }
});

test('queryOrders: đơn chỉ có ở Kiot -> "Đơn chưa gửi kế toán" (NOT_SENT), cột mốc rỗng, không cảnh báo, mặc định đơn mới đặt nhất trước', async () => {
  const ctx = freshService([record({ orderCode: 'DH000001', _branch: 'HN', saleSentAt: '01/10/2026 08:00' })]);
  try {
    const { orders } = await ctx.service.queryOrders({}, {
      kiot: fakeKiot({ ok: true, orders: [
        kiotOrder({ code: 'DH041249', orderDate: '01/10/2026 13:00' }),
        kiotOrder({ code: 'DH041250', orderDate: '02/10/2026 09:00' })
      ] })
    });
    assert.deepEqual(orders.map(o => o.orderCode), ['DH041250', 'DH041249'], 'sap theo thoi gian dat hang that, moi nhat truoc; dong sheet khong khop bi bo');
    const kiotOnly = orders[0];
    assert.equal(kiotOnly.source, 'kiotviet');
    assert.equal(kiotOnly.summary.code, 'NOT_SENT');
    assert.equal(kiotOnly.summary.label, 'Đơn chưa gửi kế toán');
    assert.equal(kiotOnly.summary.at, '02/10/2026 09:00', 'don chua gui ke toan: thoi gian dat hang vao cot Cap nhat gan nhat');
    assert.equal(kiotOnly.warning, false);
    assert.equal(kiotOnly.branch, 'HN');
    assert.equal(kiotOnly.saleName, 'Nguyễn Văn A');
    assert.equal(kiotOnly.customerName, 'KH Kiot');
    assert.equal(kiotOnly.saleSentAt, '');
    assert.equal(kiotOnly.kiotStatus, 'Phiếu tạm');
    assert.equal(kiotOnly.note, 'Giao sớm');
    assert.equal(kiotOnly.sellableValue, 6000000);
    assert.equal(kiotOnly.orderTotal, 8091000);
  } finally {
    ctx.restore();
  }
});

test('queryOrders: thời gian đặt hàng chỉ thay mốc "Cập nhật gần nhất" của đơn chưa gửi kế toán; đơn đã có mốc giữ nguyên', async () => {
  const ctx = freshService([
    record({ orderCode: 'DH000010', _branch: 'HN' }), // sheet, chua gui ke toan, khop Kiot
    record({ orderCode: 'DH000011', _branch: 'HN', saleSentAt: '01/10/2026 08:00' }) // da gui ke toan, khop Kiot
  ]);
  try {
    const { orders } = await ctx.service.queryOrders({}, {
      kiot: fakeKiot({ ok: true, orders: [
        kiotOrder({ code: 'DH000010', orderDate: '30/09/2026 10:00' }),
        kiotOrder({ code: 'DH000011', orderDate: '30/09/2026 11:00' })
      ] })
    });
    const notSent = orders.find(o => o.orderCode === 'DH000010');
    assert.equal(notSent.summary.code, 'NOT_SENT');
    assert.equal(notSent.summary.at, '30/09/2026 10:00');
    const sent = orders.find(o => o.orderCode === 'DH000011');
    assert.equal(sent.summary.code, 'SENT_TO_ACCOUNTANT');
    assert.equal(sent.summary.at, '01/10/2026 08:00', 'khong bi thoi gian dat hang de len moc cua trang thai da gui');
  } finally {
    ctx.restore();
  }
});

test('queryOrders: KHÓA THEO CƠ SỞ — cùng mã DH ở HN và SG không bị coi là trùng', async () => {
  const ctx = freshService([record({ orderCode: 'DH018717', _branch: 'HN', saleSentAt: '01/10/2026 08:00' })]);
  try {
    const { orders } = await ctx.service.queryOrders({}, {
      kiot: fakeKiot({ ok: true, orders: [kiotOrder({ branch: 'SG', code: 'DH018717' })] })
    });
    assert.equal(orders.length, 1, 'dong sheet HN KHONG khop don SG nen bi bo; don SG chi o Kiot van hien');
    assert.equal(orders[0].source, 'kiotviet');
    assert.equal(orders[0].branch, 'SG');
  } finally {
    ctx.restore();
  }
});

test('queryOrders: không áp ghi đè lịch sử (khoá theo mã) lên đơn chỉ có ở Kiot; dòng sheet vẫn áp ghi đè', async () => {
  const ctx = freshService(
    [record({ orderCode: 'DH000001', _branch: 'HN' })],
    [overrideRow({ order_code: 'DH000001', to_status_code: 'CANCELLED', to_status_label: 'Đã hủy' }),
      overrideRow({ history_id: 'OVR-2', order_code: 'DH041173', to_status_code: 'CANCELLED', to_status_label: 'Đã hủy' })]
  );
  try {
    const { orders } = await ctx.service.queryOrders({}, { kiot: fakeKiot({ ok: true, orders: [kiotOrder(), kiotOrder({ code: 'DH000001' })] }) });
    assert.equal(orders.find(o => o.orderCode === 'DH000001').summary.code, 'CANCELLED');
    assert.equal(orders.find(o => o.orderCode === 'DH041173').summary.code, 'NOT_SENT', 'ghi de theo ma khong ap cho don Kiot');
  } finally {
    ctx.restore();
  }
});

test('queryOrders: lọc cơ sở áp cho cả đơn Kiot (tổng = số đơn của cơ sở); dòng sheet mã trống không bao giờ khớp', async () => {
  const ctx = freshService([
    record({ orderCode: '', _branch: 'HN' }),
    record({ orderCode: 'DH000002', _branch: 'SG' })
  ]);
  try {
    const kiot = fakeKiot({ ok: true, orders: [kiotOrder({ branch: 'HN', code: 'DH041173' }), kiotOrder({ branch: 'SG', code: 'DH019082' })] });
    const sg = await ctx.service.queryOrders({ branch: 'SG' }, { kiot });
    assert.deepEqual(sg.orders.map(o => o.orderCode), ['DH019082'], 'DH000002 (sheet) khong co tren Kiot nen bi bo');
    assert.deepEqual([sg.total, sg.filteredTotal], [1, 1]);
    const hn = await ctx.service.queryOrders({ branch: 'HN' }, { kiot });
    assert.deepEqual(hn.orders.map(o => [o.orderCode, o.source]), [['DH041173', 'kiotviet']], 'dong sheet ma trong khong bao gio khop');
    const both = await ctx.service.queryOrders({}, { kiot });
    assert.equal(both.total, 2);
  } finally {
    ctx.restore();
  }
});

test('queryOrders: nguồn Kiot lỗi (ok:false) -> chỉ còn dòng sheet (không có dữ liệu Kiot), meta báo ok:false; đọc đủ 2 nguồn song song', async () => {
  const ctx = freshService([record({ orderCode: 'DH000001', _branch: 'HN' })]);
  try {
    const kiot = fakeKiot({ ok: false, stale: false, fetchedAt: null, orders: [] });
    const { orders, kiot: meta } = await ctx.service.queryOrders({}, { kiot });
    assert.deepEqual(orders.map(o => [o.orderCode, o.source, o.kiotStatus, o.orderTotal, o.note]), [['DH000001', 'sheet', '', null, '']]);
    assert.deepEqual(meta, { ok: false, stale: false, fetchedAt: null, count: 0 });
    assert.equal(kiot.calls.reads, 1);
  } finally {
    ctx.restore();
  }
});

test('queryOrders KHÔNG truyền kiot: chỉ dòng sheet, kiot=null; listAllOrders giữ nguyên hình dạng cũ (không thêm trường mới)', async () => {
  const ctx = freshService([record({ orderCode: 'HD001', _branch: 'HN' })]);
  try {
    const page = await ctx.service.queryOrders({});
    assert.equal(page.kiot, null);
    assert.deepEqual(page.orders.map(o => o.orderCode), ['HD001']);
    const legacy = (await ctx.service.listAllOrders())[0];
    for (const field of ['source', 'kiotStatus', 'sellableValue', 'orderTotal', 'orderDate', 'note']) {
      assert.equal(field in legacy, false, `${field} chi co khi gop Kiot`);
    }
  } finally {
    ctx.restore();
  }
});

// Bo loc / sap xep / cat trang chay TREN MAY CHU (chi tiet tung bo loc: orderLifecycleQuery.test.js).
test('queryOrders: lọc theo trạng thái Kiot + trạng thái vòng đời + tìm kiếm, cắt trang, đếm đã lọc / tổng', async () => {
  const ctx = freshService([record({ orderCode: 'DH000003', _branch: 'HN', saleSentAt: '01/10/2026 08:00', driverConfirmedDeliveryAt: '01/10/2026 09:00' })]);
  try {
    const orders = [];
    for (let i = 1; i <= 7; i++) {
      orders.push(kiotOrder({
        code: 'DH00000' + i, orderDate: `0${i}/10/2026 10:00`,
        kiotStatus: i % 2 ? 'Hoàn thành' : 'Phiếu tạm', sellableValue: i % 2 ? null : 100, saleName: i === 5 ? 'Trần Thị Bình' : 'Nguyễn Văn A'
      }));
    }
    const kiot = fakeKiot({ ok: true, orders });
    const all = await ctx.service.queryOrders({ pageSize: '3' }, { kiot });
    assert.deepEqual([all.total, all.filteredTotal, all.totalPages, all.page, all.pageSize], [7, 7, 3, 1, 3]);
    assert.deepEqual(all.orders.map(o => o.orderCode), ['DH000007', 'DH000006', 'DH000005'], 'trang 1, don moi dat nhat truoc');

    const last = await ctx.service.queryOrders({ pageSize: '3', page: '9' }, { kiot });
    assert.equal(last.page, 3, 'trang vuot qua bi kep ve trang cuoi');
    assert.deepEqual(last.orders.map(o => o.orderCode), ['DH000001']);

    const done = await ctx.service.queryOrders({ kiotStatus: 'Hoàn thành' }, { kiot });
    assert.deepEqual([done.filteredTotal, done.total], [4, 7]);
    assert.deepEqual(done.kiotStatuses, ['Phiếu tạm', 'Hoàn thành'], 'danh sach o loc khong thu hep theo bo loc');

    const delivering = await ctx.service.queryOrders({ status: 'DELIVERING' }, { kiot });
    assert.deepEqual(delivering.orders.map(o => o.orderCode), ['DH000003']);

    const bySale = await ctx.service.queryOrders({ mode: 'sale', q: 'tran thi binh' }, { kiot });
    assert.deepEqual(bySale.orders.map(o => o.orderCode), ['DH000005']);

    const sorted = await ctx.service.queryOrders({ kiotStatus: 'Phiếu tạm', sort: 'orderCode', dir: 'asc' }, { kiot });
    assert.deepEqual(sorted.orders.map(o => o.orderCode), ['DH000002', 'DH000004', 'DH000006']);
  } finally {
    ctx.restore();
  }
});

// Chi dinh vi tri (migration 0096): pickStatuses() tra Map 'HN|ma don chu thuong' -> trang thai MOI NHAT; gan `pickStatus` len cac dong
// cua TRANG tra ve (khong sua dong trong cache) va loc `pickStatus` bang cach thu hep tap dong truoc khi loc/sap xep.
test('sort=pickStatus: Chưa bốc, Đang bốc, Đã bốc, Đã hủy (tăng dần), đảo khi giảm dần; xuất Excel cùng thứ tự; không có bản đồ chỉ định thì không vỡ', async () => {
  const ctx = freshService([]);
  try {
    const orders = [1, 2, 3, 4].map(i => kiotOrder({ code: 'DH00000' + i, orderDate: `0${i}/10/2026 10:00` }));
    const kiot = fakeKiot({ ok: true, orders });
    // DH1 chưa có chỉ định (Chưa bốc), DH2 Đã hủy, DH3 Đã bốc, DH4 Đang bốc.
    const pickStatuses = async () => new Map([['HN|dh000002', 'cancelled'], ['HN|dh000003', 'confirmed'], ['HN|dh000004', 'picking']]);
    const asc = await ctx.service.queryOrders({ sort: 'pickStatus', dir: 'asc' }, { kiot, pickStatuses });
    assert.deepEqual(asc.orders.map(o => o.orderCode), ['DH000001', 'DH000004', 'DH000003', 'DH000002']);
    const desc = await ctx.service.queryOrders({ sort: 'pickStatus', dir: 'desc' }, { kiot, pickStatuses });
    assert.deepEqual(desc.orders.map(o => o.orderCode), ['DH000002', 'DH000003', 'DH000004', 'DH000001']);
    // Sort theo cột khác sau đó vẫn dùng cache bình thường, không bị lây gia trị pickStatus.
    const byDate = await ctx.service.queryOrders({}, { kiot, pickStatuses });
    assert.deepEqual(byDate.orders.map(o => o.orderCode), ['DH000004', 'DH000003', 'DH000002', 'DH000001']);
    const exported = await ctx.service.exportOrders({ sort: 'pickStatus', dir: 'asc' }, { kiot, pickStatuses });
    assert.deepEqual(exported.map(o => o.orderCode), ['DH000001', 'DH000004', 'DH000003', 'DH000002']);
    // Người không có quyền (không truyền pickStatuses): sort hợp lệ, không lỗi, không thêm trường pickStatus.
    const noPerm = await ctx.service.queryOrders({ sort: 'pickStatus' }, { kiot });
    assert.equal(noPerm.orders.length, 4);
    assert.ok(noPerm.orders.every(o => !('pickStatus' in o)));
  } finally {
    ctx.restore();
  }
});

test('queryOrders + pickStatuses: dong cua trang co pickStatus (null neu chua chi dinh), loc theo pickStatus, KPI theo tap da loc; khong truyen thi khong them truong', async () => {
  const ctx = freshService([]);
  try {
    const orders = [1, 2, 3, 4].map(i => kiotOrder({ code: 'DH00000' + i, orderDate: `0${i}/10/2026 10:00` }));
    const kiot = fakeKiot({ ok: true, orders });
    const pickStatuses = async () => new Map([['HN|dh000002', 'picking'], ['HN|dh000003', 'confirmed'], ['HN|dh000004', 'cancelled'], ['SG|dh000001', 'picking']]);
    const all = await ctx.service.queryOrders({}, { kiot, pickStatuses });
    assert.deepEqual(all.orders.map(o => [o.orderCode, o.pickStatus]), [['DH000004', 'cancelled'], ['DH000003', 'confirmed'], ['DH000002', 'picking'], ['DH000001', null]]);
    assert.equal(all.total, 4);
    const picking = await ctx.service.queryOrders({ pickStatus: 'picking' }, { kiot, pickStatuses });
    assert.deepEqual(picking.orders.map(o => o.orderCode), ['DH000002']);
    assert.deepEqual([picking.filteredTotal, picking.total], [1, 4], 'tong theo co so khong thu hep, so da loc thu hep');
    assert.equal((await ctx.service.queryOrders({ pickStatus: 'confirmed', pageSize: '1' }, { kiot, pickStatuses })).filteredTotal, 1);
    assert.equal((await ctx.service.queryOrders({ pickStatus: 'cancelled', branch: 'SG' }, { kiot, pickStatuses })).filteredTotal, 0);
    // Dong trong cache khong bi gan truong (ban sao nong): goi lai khong co pickStatuses thi khong co truong pickStatus.
    const plain = await ctx.service.queryOrders({}, { kiot });
    assert.ok(plain.orders.every(o => !('pickStatus' in o)));
    // Xuat Excel loc cung bo tham so.
    const exported = await ctx.service.exportOrders({ pickStatus: 'confirmed' }, { kiot, pickStatuses });
    assert.deepEqual(exported.map(o => o.orderCode), ['DH000003']);
    await assert.rejects(ctx.service.queryOrders({ pickStatus: 'x' }, { kiot, pickStatuses }), { statusCode: 400, code: 'INVALID_PICK_STATUS' });
  } finally {
    ctx.restore();
  }
});

test('queryOrders: bo loc "none" (Chua boc) = don khong co khoa chi chi dinh; canh bao Lech Kiot / Lech SL trong don cong vao warnings, loc/dem/xuat duoc', async () => {
  const ctx = freshService([]);
  try {
    const orders = [1, 2, 3, 4].map(i => kiotOrder({ code: 'DH00000' + i, orderDate: `0${i}/10/2026 10:00` }));
    const kiot = fakeKiot({ ok: true, orders });
    const pickStatuses = async () => new Map([['HN|dh000002', 'picking'], ['HN|dh000003', 'confirmed'], ['HN|dh000004', 'cancelled']]);
    const pickWarnings = async () => new Map([['HN|dh000002', ['PICK_KIOT_DIFF']], ['HN|dh000003', ['PICK_KIOT_DIFF', 'PICK_ORDER_DIFF']]]);
    const none = await ctx.service.queryOrders({ pickStatus: 'none' }, { kiot, pickStatuses, pickWarnings });
    assert.deepEqual(none.orders.map(o => o.orderCode), ['DH000001'], 'Chua boc = khong co khoa (khong co chi dinh / Kiot huy don)');
    const all = await ctx.service.queryOrders({}, { kiot, pickStatuses, pickWarnings });
    assert.deepEqual(all.orders.map(o => [o.orderCode, o.warnings]), [
      ['DH000004', []], ['DH000003', ['PICK_KIOT_DIFF', 'PICK_ORDER_DIFF']], ['DH000002', ['PICK_KIOT_DIFF']], ['DH000001', []]]);
    // Bo loc canh bao: ma cu the va "any" (co canh bao).
    const kiotDiff = await ctx.service.queryOrders({ warning: 'PICK_KIOT_DIFF' }, { kiot, pickStatuses, pickWarnings });
    assert.deepEqual(kiotDiff.orders.map(o => o.orderCode), ['DH000003', 'DH000002']);
    const orderDiff = await ctx.service.queryOrders({ warning: 'PICK_ORDER_DIFF' }, { kiot, pickStatuses, pickWarnings });
    assert.deepEqual(orderDiff.orders.map(o => o.orderCode), ['DH000003']);
    const any = await ctx.service.queryOrders({ warning: 'any' }, { kiot, pickStatuses, pickWarnings });
    assert.deepEqual(any.orders.map(o => o.orderCode), ['DH000003', 'DH000002']);
    // The KPI va dem theo co so tinh ca 2 ma moi; don nhieu canh bao dem 1 lan o "any".
    assert.deepEqual([all.kpis.warnings.any, all.kpis.warnings.PICK_KIOT_DIFF, all.kpis.warnings.PICK_ORDER_DIFF], [2, 2, 1]);
    assert.equal(all.warningCounts.PICK_KIOT_DIFF, 2);
    assert.equal(all.facets.warning.PICK_ORDER_DIFF, 1);
    // Khong truyen pickWarnings (nguoi khong co quyen) thi khong co ma canh bao chi dinh.
    const plain = await ctx.service.queryOrders({}, { kiot, pickStatuses });
    assert.ok(plain.orders.every(o => !o.warnings.some(code => code.startsWith('PICK_'))));
    assert.equal((await ctx.service.queryOrders({ warning: 'PICK_KIOT_DIFF' }, { kiot, pickStatuses })).orders.length, 0);
    // Xuat Excel dung cung bo tham so (loc none, loc canh bao).
    assert.deepEqual((await ctx.service.exportOrders({ pickStatus: 'none' }, { kiot, pickStatuses })).map(o => o.orderCode), ['DH000001']);
    assert.deepEqual((await ctx.service.exportOrders({ warning: 'PICK_ORDER_DIFF' }, { kiot, pickStatuses, pickWarnings })).map(o => o.orderCode), ['DH000003']);
    // pickWarnings loi/rong khong lam hong danh sach.
    const empty = await ctx.service.queryOrders({ warning: 'any' }, { kiot, pickStatuses, pickWarnings: async () => new Map() });
    assert.equal(empty.orders.length, 0);
  } finally {
    ctx.restore();
  }
});

test('findMergedOrder: tim dong gop theo (co so, ma don) khong phan biet hoa/thuong; khac co so hoac khong co -> null', async () => {
  const ctx = freshService([]);
  try {
    const kiot = fakeKiot({ ok: true, orders: [kiotOrder({ code: 'DH000001', branch: 'HN' }), kiotOrder({ code: 'DH000002', branch: 'SG' })] });
    const hit = await ctx.service.findMergedOrder('SG', ' dh000002 ', { kiot });
    assert.equal(hit.orderCode, 'DH000002');
    assert.equal(hit.summary.code, 'NOT_SENT');
    assert.equal(await ctx.service.findMergedOrder('HN', 'DH000002', { kiot }), null);
    assert.equal(await ctx.service.findMergedOrder('HN', 'KHONGCO', { kiot }), null);
  } finally {
    ctx.restore();
  }
});

test('queryOrders: tham số không hợp lệ -> lỗi 400 kèm mã, trước khi đọc nguồn dữ liệu', async () => {
  const ctx = freshService([]);
  try {
    const kiot = fakeKiot({ ok: true, orders: [] });
    await assert.rejects(ctx.service.queryOrders({ branch: 'XX' }, { kiot }), { statusCode: 400, code: 'INVALID_BRANCH' });
    await assert.rejects(ctx.service.queryOrders({ sort: 'khong-co' }, { kiot }), { statusCode: 400, code: 'INVALID_SORT' });
    await assert.rejects(ctx.service.queryOrders({ dateField: 'x' }, { kiot }), { statusCode: 400, code: 'INVALID_DATE_FIELD' });
    await assert.rejects(ctx.service.queryOrders({ from: '01/10/2026' }, { kiot }), { statusCode: 400, code: 'INVALID_DATE' });
    assert.equal(kiot.calls.reads, 0);
  } finally {
    ctx.restore();
  }
});

test('queryOrders: danh sách đã gộp được dùng lại khi dữ liệu nguồn không đổi; dựng lại khi danh sách Kiot mới hoặc qua phút khác (cảnh báo phụ thuộc đồng hồ)', async () => {
  const realNow = Date.now;
  const ctx = freshService([record({ orderCode: 'DH000001', _branch: 'HN', saleSentAt: '01/10/2026 08:00' })]);
  try {
    const orders = [kiotOrder({ code: 'DH000001' }), kiotOrder({ code: 'DH000002' })];
    const result = { ok: true, orders };
    // 01/10/2026 08:20 gio VN = 01:20Z: moi 20 phut ke tu luc Sale ra don -> chua canh bao
    Date.now = () => Date.UTC(2026, 9, 1, 1, 20, 0);
    const first = await ctx.service.queryOrders({}, { kiot: fakeKiot(result) });
    const second = await ctx.service.queryOrders({ page: '1' }, { kiot: fakeKiot(result) });
    assert.equal(second.orders[0], first.orders[0], 'cung du lieu + cung phut: dung lai dung doi tuong dong');
    assert.equal(first.orders.find(o => o.orderCode === 'DH000001').warning, false);

    const fresh = await ctx.service.queryOrders({}, { kiot: fakeKiot({ ok: true, orders: [...orders] }) });
    assert.notEqual(fresh.orders[0], first.orders[0], 'mang don Kiot moi (da doc lai DB) -> dung lai danh sach');

    Date.now = () => Date.UTC(2026, 9, 3, 2, 0, 0); // 2 ngay sau, du lieu khong doi
    const later = await ctx.service.queryOrders({}, { kiot: fakeKiot(result) }); // cung mang don Kiot: chi co dong ho doi
    assert.equal(later.orders.find(o => o.orderCode === 'DH000001').warning, true, 'qua 24h chua van chuyen -> canh bao, du du lieu nguon khong doi');
  } finally {
    Date.now = realNow;
    ctx.restore();
  }
});

test('lookup (findOrder) và ghi đè KHÔNG dùng dữ liệu Kiot: đơn chỉ có ở Kiot -> chưa gửi kế toán / 404', async () => {
  const ctx = freshService([record({ orderCode: 'DH000001', _branch: 'HN' })]);
  try {
    const found = await ctx.service.findOrder('DH041173');
    assert.equal(found.found, false);
    assert.equal(found.summary.code, 'NOT_SENT');
    assert.equal(ctx.service.findOrdersBulk, undefined, 'tra cuu nhieu ma (POST /lookup) da go');
    await assert.rejects(
      ctx.service.overrideStatus('DH041173', { code: 'CANCELLED', changedBy: 'X', changedByRole: 'Quản lý' }),
      { statusCode: 404, code: 'ORDER_NOT_FOUND' }
    );
  } finally {
    ctx.restore();
  }
});

test('exportOrders: trả TOÀN BỘ dòng đã lọc + sắp xếp (không cắt trang), cùng bộ tham số như queryOrders', async () => {
  const ctx = freshService([record({ orderCode: 'DH000001', _branch: 'HN' })]);
  try {
    const orders = Array.from({ length: 120 }, (_, i) => kiotOrder({
      code: 'DH' + String(i + 1).padStart(6, '0'), orderDate: '01/10/2026 10:00', kiotStatus: i % 4 === 0 ? 'Hoàn thành' : 'Phiếu tạm'
    }));
    const kiot = fakeKiot({ ok: true, orders });
    const all = await ctx.service.exportOrders({}, { kiot });
    assert.equal(all.length, 120, 'nhieu hon 1 trang (100 dong) van xuat du');
    const paged = await ctx.service.exportOrders({ page: '2', pageSize: '10' }, { kiot });
    assert.equal(paged.length, 120, 'tham so trang khong cat file xuat');

    const done = await ctx.service.exportOrders({ kiotStatus: 'Hoàn thành', sort: 'orderCode', dir: 'desc' }, { kiot });
    assert.equal(done.length, 30);
    assert.equal(done[0].orderCode, 'DH000117');
    assert.equal(done[29].orderCode, 'DH000001');
    assert.equal(done[0].sellableValue, 6000000, 'dong xuat day du truong cua don Kiot');
    assert.equal(done[0].note, 'Giao sớm');
  } finally {
    ctx.restore();
  }
});

test('toDetail (qua findOrder) trả kèm customerName', async () => {
  const ctx = freshService([record({ orderCode: 'HD001', saleName: 'Sale A', customerName: 'KH A', saleSentAt: '01/09/2026' })]);
  try {
    const result = await ctx.service.findOrder('HD001');
    assert.equal(result.detail.customerName, 'KH A');
  } finally {
    ctx.restore();
  }
});

test('exportOrders KHÔNG truyền kiot: chỉ dòng sheet, giữ thứ tự trong sheet khi chưa chọn sắp xếp', async () => {
  const ctx = freshService([
    record({ orderCode: 'HD001', _branch: 'HN' }),
    record({ orderCode: 'HD002', _branch: 'SG' })
  ]);
  try {
    const all = await ctx.service.exportOrders({});
    assert.deepEqual(all.map(o => o.orderCode), ['HD001', 'HD002']);
    assert.equal(all[0].branch, 'HN');
    assert.ok(all[0].summary);
  } finally {
    ctx.restore();
  }
});

test('exportOrders: lọc theo cơ sở và sắp xếp theo mã (khớp bảng đã lọc/sắp xếp trên màn hình)', async () => {
  const ctx = freshService([
    record({ orderCode: 'HD001', _branch: 'HN' }),
    record({ orderCode: 'HD002', _branch: 'SG' }),
    record({ orderCode: 'HD003', _branch: 'HN' })
  ]);
  try {
    const result = await ctx.service.exportOrders({ branch: 'HN', sort: 'orderCode', dir: 'desc' });
    assert.deepEqual(result.map(o => o.orderCode), ['HD003', 'HD001']);
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// computeEffectiveStatus — ghi de trang thai thu cong
// ---------------------------------------------------------------------------

test('computeEffectiveStatus: không có override -> giữ nguyên computed', () => {
  const ctx = freshService([]);
  try {
    const rec = record({ saleName: 'Sale A', saleSentAt: '01/09/2026' });
    const status = ctx.service.computeEffectiveStatus(rec, undefined);
    assert.equal(status.code, ctx.service.STATUS.SENT_TO_ACCOUNTANT);
    assert.equal(status.isOverride, undefined);
  } finally {
    ctx.restore();
  }
});

test('computeEffectiveStatus: override thấp hơn computed -> computed thắng (không kẹt)', () => {
  const ctx = freshService([]);
  try {
    const rec = record({
      saleSentAt: '01/09/2026', driverConfirmedDeliveryAt: '02/09/2026',
      deliveryConfirmedAt: '03/09/2026', shipReceivedAt: '04/09/2026'
    });
    const status = ctx.service.computeEffectiveStatus(rec, overrideRow({ to_status_code: 'DELIVERING' }));
    assert.equal(status.code, ctx.service.STATUS.SHIP_RECEIVED);
    assert.equal(status.isOverride, undefined);
  } finally {
    ctx.restore();
  }
});

test('computeEffectiveStatus: override cao hơn computed -> override thắng (mức sàn)', () => {
  const ctx = freshService([]);
  try {
    const rec = record({ saleName: 'Sale A', saleSentAt: '01/09/2026' }); // computed = SENT_TO_ACCOUNTANT
    const status = ctx.service.computeEffectiveStatus(rec, overrideRow({ to_status_code: 'SHIP_RECEIVED', changed_by: 'Nguyễn Văn A' }));
    assert.equal(status.code, ctx.service.STATUS.SHIP_RECEIVED);
    assert.equal(status.isOverride, true);
    assert.equal(status.actor, 'Nguyễn Văn A');
  } finally {
    ctx.restore();
  }
});

test('computeEffectiveStatus: override EXCEPTION luôn thắng bất kể computed', () => {
  const ctx = freshService([]);
  try {
    const rec = record({ shipReceivedAt: '04/09/2026' }); // computed = SHIP_RECEIVED, cao nhat
    const status = ctx.service.computeEffectiveStatus(rec, overrideRow({ to_status_code: 'EXCEPTION' }));
    assert.equal(status.code, ctx.service.STATUS.EXCEPTION);
    assert.equal(status.isOverride, true);
  } finally {
    ctx.restore();
  }
});

test('computeEffectiveStatus: override CANCELLED luôn thắng bất kể computed', () => {
  const ctx = freshService([]);
  try {
    const rec = record({ shipReceivedAt: '04/09/2026' });
    const status = ctx.service.computeEffectiveStatus(rec, overrideRow({ to_status_code: 'CANCELLED' }));
    assert.equal(status.code, ctx.service.STATUS.CANCELLED);
    assert.equal(status.isOverride, true);
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// findOrder/listAllOrders ap dung override tu tab "Lich su cap nhat"
// ---------------------------------------------------------------------------

test('findOrder: áp dụng override mới nhất từ lịch sử cập nhật', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [overrideRow({ order_code: 'HD001', to_status_code: 'SHIP_RECEIVED' })]
  );
  try {
    const result = await ctx.service.findOrder('HD001');
    assert.equal(result.summary.code, ctx.service.STATUS.SHIP_RECEIVED);
    assert.equal(result.summary.isOverride, true);
  } finally {
    ctx.restore();
  }
});

test('listAllOrders: dùng dòng override CUỐI CÙNG khớp mã đơn (append theo thời gian)', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [
      overrideRow({ order_code: 'HD001', to_status_code: 'DELIVERING' }),
      overrideRow({ order_code: 'HD001', to_status_code: 'EXCEPTION' })
    ]
  );
  try {
    const all = await ctx.service.listAllOrders();
    assert.equal(all[0].summary.code, ctx.service.STATUS.EXCEPTION);
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// overrideStatus
// ---------------------------------------------------------------------------

test('overrideStatus: mã đơn không tồn tại -> lỗi 404 ORDER_NOT_FOUND', async () => {
  const ctx = freshService([record({ orderCode: 'HD001' })]);
  try {
    await assert.rejects(
      () => ctx.service.overrideStatus('HD999', { code: 'CANCELLED', changedBy: 'A', changedByRole: 'Kế toán' }),
      err => err.statusCode === 404 && err.code === 'ORDER_NOT_FOUND'
    );
  } finally {
    ctx.restore();
  }
});

test('overrideStatus: trạng thái không hợp lệ -> lỗi 400 INVALID_STATUS', async () => {
  const ctx = freshService([record({ orderCode: 'HD001' })]);
  try {
    await assert.rejects(
      () => ctx.service.overrideStatus('HD001', { code: 'KHONG_TON_TAI', changedBy: 'A', changedByRole: 'Kế toán' }),
      err => err.statusCode === 400 && err.code === 'INVALID_STATUS'
    );
  } finally {
    ctx.restore();
  }
});

test('overrideStatus: ghi đúng câu tường thuật + trả về trạng thái hiệu lực mới', async () => {
  const ctx = freshService([record({ orderCode: 'HD001' })]);
  try {
    const result = await ctx.service.overrideStatus('HD001', {
      code: 'DELIVERED', changedBy: 'Nguyễn Văn A', changedByRole: 'Kế toán'
    });
    assert.equal(ctx.appended.length, 1);
    assert.equal(
      ctx.appended[0].message,
      'Nguyễn Văn A - Kế toán đã cập nhật đơn hàng sang trạng thái Đơn đã giao thành công.'
    );
    assert.equal(ctx.appended[0].order_code, 'HD001');
    assert.equal(result.summary.code, ctx.service.STATUS.DELIVERED);
    assert.equal(result.summary.isOverride, true);
  } finally {
    ctx.restore();
  }
});

test('overrideStatus: ghi kèm trạng thái cũ = trạng thái tính từ mốc thời gian (chưa có override trước đó)', async () => {
  const ctx = freshService([record({ orderCode: 'HD001', saleName: 'Sale A', saleSentAt: '01/09/2026' })]);
  try {
    await ctx.service.overrideStatus('HD001', { code: 'SHIP_RECEIVED', changedBy: 'A', changedByRole: 'Quản lý' });
    assert.equal(ctx.appended[0].from_status_code, ctx.service.STATUS.SENT_TO_ACCOUNTANT);
    assert.equal(ctx.appended[0].from_status_label, ctx.service.STATUS_LABEL[ctx.service.STATUS.SENT_TO_ACCOUNTANT]);
  } finally {
    ctx.restore();
  }
});

test('overrideStatus: ghi kèm trạng thái cũ = override GẦN NHẤT trước đó (không phải trạng thái tính từ mốc thời gian)', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [overrideRow({ order_code: 'HD001', to_status_code: 'EXCEPTION' })]
  );
  try {
    await ctx.service.overrideStatus('HD001', { code: 'CANCELLED', changedBy: 'A', changedByRole: 'Quản lý' });
    assert.equal(ctx.appended[0].from_status_code, 'EXCEPTION');
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// listHistory — tab "Lich su cap nhat" hien thi tren web (truoc gio chi doc
// noi bo de tinh trang thai hieu luc)
// ---------------------------------------------------------------------------

test('listHistory: mới nhất hiển thị trước (sheet ghi nối tiếp -> đảo ngược mảng)', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [
      overrideRow({ history_id: 'OVR-1', order_code: 'HD001', to_status_code: 'DELIVERING' }),
      overrideRow({ history_id: 'OVR-2', order_code: 'HD001', to_status_code: 'SHIP_RECEIVED' })
    ]
  );
  try {
    const history = await ctx.service.listHistory();
    assert.deepEqual(history.map(h => h.historyId), ['OVR-2', 'OVR-1']);
  } finally {
    ctx.restore();
  }
});

test('listHistory: kèm branch join theo mã đơn từ bảng chính', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001', _branch: 'HN' }), record({ orderCode: 'HD002', _branch: 'SG' })],
    [
      overrideRow({ history_id: 'OVR-1', order_code: 'HD001' }),
      overrideRow({ history_id: 'OVR-2', order_code: 'HD002' })
    ]
  );
  try {
    const history = await ctx.service.listHistory();
    const byId = Object.fromEntries(history.map(h => [h.historyId, h.branch]));
    assert.equal(byId['OVR-1'], 'HN');
    assert.equal(byId['OVR-2'], 'SG');
  } finally {
    ctx.restore();
  }
});

test('listHistory: mã đơn không còn trong bảng chính -> branch null (không throw)', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [overrideRow({ history_id: 'OVR-1', order_code: 'HD_DA_XOA' })]
  );
  try {
    const history = await ctx.service.listHistory();
    assert.equal(history[0].branch, null);
  } finally {
    ctx.restore();
  }
});

test('listHistory: giữ nguyên statusLabel/changedBy/note/message từ dòng lịch sử', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [overrideRow({
      history_id: 'OVR-1', order_code: 'HD001', to_status_code: 'CANCELLED', to_status_label: 'Đã hủy',
      changed_by: 'Trần Thị B', changed_by_role: 'Quản lý', note: 'Khách hủy đơn'
    })]
  );
  try {
    const [entry] = await ctx.service.listHistory();
    assert.equal(entry.statusCode, 'CANCELLED');
    assert.equal(entry.statusLabel, 'Đã hủy');
    assert.equal(entry.changedBy, 'Trần Thị B');
    assert.equal(entry.changedByRole, 'Quản lý');
    assert.equal(entry.note, 'Khách hủy đơn');
  } finally {
    ctx.restore();
  }
});

test('listHistory: trả kèm trạng thái cũ (from_status_code/label) từ dòng lịch sử', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [overrideRow({
      history_id: 'OVR-1', order_code: 'HD001', to_status_code: 'CANCELLED',
      from_status_code: 'DELIVERING', from_status_label: 'Đơn đang được giao'
    })]
  );
  try {
    const [entry] = await ctx.service.listHistory();
    assert.equal(entry.fromStatusCode, 'DELIVERING');
    assert.equal(entry.fromStatusLabel, 'Đơn đang được giao');
  } finally {
    ctx.restore();
  }
});

test('listHistory: dòng lịch sử cũ chưa có cột trạng thái cũ -> trả rỗng thay vì undefined', async () => {
  const ctx = freshService(
    [record({ orderCode: 'HD001' })],
    [overrideRow({ history_id: 'OVR-1', order_code: 'HD001', from_status_code: undefined, from_status_label: undefined })]
  );
  try {
    const [entry] = await ctx.service.listHistory();
    assert.equal(entry.fromStatusCode, '');
    assert.equal(entry.fromStatusLabel, '');
  } finally {
    ctx.restore();
  }
});

