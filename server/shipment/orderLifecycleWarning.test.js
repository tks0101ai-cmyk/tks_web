'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Service doc repo qua require.cache — thay bang ban gia de test khong can Google Sheets/.env.
function freshService(rows, historyRows) {
  const repoPath = require.resolve('./orderLifecycleRepository');
  const servicePath = require.resolve('./orderLifecycleService');
  const previousRepo = require.cache[repoPath];
  require.cache[repoPath] = {
    id: repoPath,
    filename: repoPath,
    loaded: true,
    exports: {
      readAll: async () => rows || [],
      readOverrideHistory: async () => historyRows || [],
      appendOverride: async entry => Object.assign({ history_id: 'OVR-TEST', changed_at: '2026-09-30 10:00:00' }, entry)
    }
  };
  delete require.cache[servicePath];
  const service = require('./orderLifecycleService');
  return {
    service,
    restore() {
      delete require.cache[servicePath];
      if (previousRepo) require.cache[repoPath] = previousRepo;
      else delete require.cache[repoPath];
    }
  };
}

function record(overrides) {
  return Object.assign({
    orderCode: 'HD001', saleName: '', customerName: '',
    saleSentAt: '', accountantApprovedOrderAt: '', driverName: '',
    driverConfirmedDeliveryAt: '', accountantApprovedDeliveryAt: '', deliveryConfirmedAt: '',
    shipReceivedAt: '', orderSignedAt: '', _branch: 'HN'
  }, overrides);
}

function warningsFor(service, rec, nowText, summary) {
  const now = service.parseSheetTimeMs(nowText);
  return service.computeWarnings(rec, summary || service.computeStatus(rec), now);
}

function pickupRecord(overrides) {
  return record(Object.assign({ _flow: 'PICKUP' }, overrides));
}

test('parseSheetTimeMs: đọc dd/MM/yyyy HH:mm(:ss), "15,35", chỉ ngày và YYYY-MM-DD HH:mm:ss theo giờ Việt Nam', () => {
  const ctx = freshService();
  try {
    const { parseSheetTimeMs } = ctx.service;
    assert.equal(parseSheetTimeMs('30/09/2026 10:47'), Date.UTC(2026, 8, 30, 3, 47));
    assert.equal(parseSheetTimeMs('30/09/2026 10:47:30'), Date.UTC(2026, 8, 30, 3, 47, 30));
    assert.equal(parseSheetTimeMs('30/09/2026 15,35'), Date.UTC(2026, 8, 30, 8, 35));
    assert.equal(parseSheetTimeMs('30/09/2026'), Date.UTC(2026, 8, 29, 17, 0));
    assert.equal(parseSheetTimeMs('2026-09-30 10:47:00'), parseSheetTimeMs('30/09/2026 10:47'));
    assert.equal(parseSheetTimeMs(''), null);
    assert.equal(parseSheetTimeMs(null), null);
    assert.equal(parseSheetTimeMs('không phải ngày'), null);
  } finally {
    ctx.restore();
  }
});

test('workingMsBetween: chỉ đếm 6h–18h giờ VN, qua đêm cộng phần sáng hôm sau', () => {
  const ctx = freshService();
  try {
    const { workingMsBetween, parseSheetTimeMs: t } = ctx.service;
    const MIN = 60 * 1000;
    assert.equal(workingMsBetween(t('12/10/2026 10:00'), t('12/10/2026 10:30')), 30 * MIN);
    assert.equal(workingMsBetween(t('12/10/2026 17:50'), t('13/10/2026 06:20')), 30 * MIN);
    assert.equal(workingMsBetween(t('12/10/2026 22:00'), t('13/10/2026 06:30')), 30 * MIN);
    assert.equal(workingMsBetween(t('12/10/2026 19:00'), t('13/10/2026 05:59')), 0);
    assert.equal(workingMsBetween(t('12/10/2026 10:00'), t('12/10/2026 09:00')), 0);
  } finally {
    ctx.restore();
  }
});

test('Kế toán sót đơn: 30 phút trong giờ 6h–18h, mất khi có Kế toán duyệt đơn; áp cho mọi luồng', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const sent = record({ saleSentAt: '12/10/2026 10:00' });
    assert.deepEqual(warningsFor(ctx.service, sent, '12/10/2026 10:29'), []);
    assert.deepEqual(warningsFor(ctx.service, sent, '12/10/2026 10:30'), [W.ACCOUNTANT_LATE]);
    const evening = record({ saleSentAt: '12/10/2026 17:50' });
    assert.deepEqual(warningsFor(ctx.service, evening, '12/10/2026 23:00'), []);
    assert.deepEqual(warningsFor(ctx.service, evening, '13/10/2026 06:19'), []);
    assert.deepEqual(warningsFor(ctx.service, evening, '13/10/2026 06:20'), [W.ACCOUNTANT_LATE]);
    const approved = record({ saleSentAt: '12/10/2026 10:00', accountantApprovedOrderAt: '12/10/2026 11:00' });
    assert.deepEqual(warningsFor(ctx.service, approved, '12/10/2026 12:00'), []);
    ['PICKUP', 'NORTH_SOUTH'].forEach(flow => {
      const rec = record({ saleSentAt: '12/10/2026 10:00', _flow: flow });
      assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 11:00'), [W.ACCOUNTANT_LATE]);
    });
    assert.deepEqual(warningsFor(ctx.service, record({}), '12/10/2026 12:00'), []);
    assert.deepEqual(warningsFor(ctx.service, record({ saleSentAt: 'hôm qua' }), '12/10/2026 12:00'), []);
  } finally {
    ctx.restore();
  }
});

test('Lái xe chưa chụp đơn (DonHang_HN/SG): Sale gửi >24h, chưa Tài xế xác nhận, chưa ký nhận; không cần KT duyệt', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const base = { saleSentAt: '11/10/2026 10:00', accountantApprovedOrderAt: '11/10/2026 10:05' };
    assert.deepEqual(warningsFor(ctx.service, record(base), '12/10/2026 10:00'), []); // đúng 24h
    assert.deepEqual(warningsFor(ctx.service, record(base), '12/10/2026 10:01'), [W.DRIVER_NO_PHOTO]);
    const notApproved = record({ saleSentAt: '11/10/2026 10:00' });
    assert.deepEqual(warningsFor(ctx.service, notApproved, '12/10/2026 10:01'), [W.ACCOUNTANT_LATE, W.DRIVER_NO_PHOTO]);
    const photographed = record(Object.assign({ driverConfirmedDeliveryAt: '12/10/2026 09:00' }, base));
    assert.deepEqual(warningsFor(ctx.service, photographed, '12/10/2026 12:00'), []);
  } finally {
    ctx.restore();
  }
});

test('Lái xe quên chụp: đã ký nhận mà chưa có Tài xế gửi xác nhận; mất khi tài xế chụp', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const signed = record({ saleSentAt: '11/10/2026 10:00', accountantApprovedOrderAt: '11/10/2026 10:05', orderSignedAt: '11/10/2026 15:00' });
    assert.deepEqual(warningsFor(ctx.service, signed, '20/10/2026 10:00'), [W.DRIVER_FORGOT_PHOTO]);
    const fixed = Object.assign({}, signed, { driverConfirmedDeliveryAt: '11/10/2026 12:00' });
    assert.deepEqual(warningsFor(ctx.service, fixed, '20/10/2026 10:00'), []);
  } finally {
    ctx.restore();
  }
});

test('Chưa nhận đơn quá 6 giờ: Tài xế gửi xác nhận >6h mà chưa ký nhận; mất khi ký nhận', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const rec = record({ saleSentAt: '12/10/2026 08:00', accountantApprovedOrderAt: '12/10/2026 08:10', driverConfirmedDeliveryAt: '12/10/2026 09:00' });
    assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 15:00'), []);
    assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 15:01'), [W.NOT_SIGNED_6H]);
    const signed = Object.assign({}, rec, { orderSignedAt: '12/10/2026 16:00' });
    assert.deepEqual(warningsFor(ctx.service, signed, '13/10/2026 10:00'), []);
  } finally {
    ctx.restore();
  }
});

test('Khách/Ship chưa lấy (Khách_HN/SG): Sale gửi >2 ngày chưa Ship nhận đơn; luồng này không có cảnh báo lái xe', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const rec = pickupRecord({ saleSentAt: '10/10/2026 10:00', accountantApprovedOrderAt: '10/10/2026 10:05' });
    assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 10:00'), []);
    assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 10:01'), [W.PICKUP_PENDING]);
    const taken = Object.assign({}, rec, { shipReceivedAt: '12/10/2026 11:00' });
    assert.deepEqual(warningsFor(ctx.service, taken, '13/10/2026 10:00'), []);
    assert.equal(ctx.service.computeStatus(taken).code, ctx.service.STATUS.SHIP_RECEIVED);
  } finally {
    ctx.restore();
  }
});

test('Chưa chụp bill tàu (DonHang_MienNam): Sale gửi >24h chưa ký nhận; mất khi ký nhận', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const rec = record({ _flow: 'NORTH_SOUTH', saleSentAt: '11/10/2026 10:00', accountantApprovedOrderAt: '11/10/2026 10:05' });
    assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 10:00'), []);
    assert.deepEqual(warningsFor(ctx.service, rec, '12/10/2026 10:01'), [W.NO_TRAIN_BILL]);
    const signed = Object.assign({}, rec, { orderSignedAt: '12/10/2026 11:00' });
    assert.deepEqual(warningsFor(ctx.service, signed, '13/10/2026 10:00'), []);
  } finally {
    ctx.restore();
  }
});

test('cảnh báo: đơn đã hủy / sự cố (ghi đè thủ công) không cảnh báo; ghi đè "Đã nhận (Đi giao xong)" coi như đã ký + đã chụp', () => {
  const ctx = freshService();
  try {
    const rec = record({ saleSentAt: '01/09/2026 08:00' });
    const at = { changed_at: '2026-09-02 09:00:00' };
    ['CANCELLED', 'EXCEPTION', 'SIGNED'].forEach(code => {
      const summary = ctx.service.computeEffectiveStatus(rec, Object.assign({ to_status_code: code }, at));
      assert.deepEqual(warningsFor(ctx.service, rec, '30/09/2026 12:00', summary), [], code);
    });
  } finally {
    ctx.restore();
  }
});

test('WARNING_LABEL: đúng 8 nhãn tiếng Việt (6 cảnh báo vận chuyển + Lệch Kiot, Lệch SL trong đơn)', () => {
  const ctx = freshService();
  try {
    assert.deepEqual(Object.values(ctx.service.WARNING_LABEL), [
      'Kế toán sót đơn', 'Lái xe chưa chụp đơn', 'Lái xe quên chụp', 'Chưa nhận đơn quá 6 giờ', 'Khách/Ship chưa lấy', 'Chưa chụp bill tàu',
      'Lệch Kiot', 'Lệch SL trong đơn'
    ]);
  } finally {
    ctx.restore();
  }
});


test('listAllOrders / queryOrders / exportOrders / overrideStatus trả kèm cờ warning', async () => {
  const ctx = freshService([
    record({ orderCode: 'HD001', saleSentAt: '01/01/2020 08:00' }), // rất cũ, chưa vận chuyển -> cảnh báo
    record({ orderCode: 'HD002' }) // chưa gửi kế toán -> không cảnh báo
  ]);
  try {
    const all = await ctx.service.listAllOrders();
    assert.deepEqual(all.map(o => o.warning), [true, false]);
    assert.equal(all[0].saleSentAt, '01/01/2020 08:00');

    const page = await ctx.service.queryOrders({});
    assert.deepEqual(page.orders.map(o => [o.orderCode, o.warning]), [['HD001', true], ['HD002', false]]);
    // Chi so tong quat dau trang: HD001 co canh bao (Ke toan sot don), don khong co dong Kiot nen khong tinh vao 'Chua gui KT'.
    assert.equal(page.kpis.warnings.any, 1);
    assert.equal(page.kpis.warnings.ACCOUNTANT_LATE, 1);
    assert.equal(page.kpis.status.SENT_TO_ACCOUNTANT, 1);
    assert.equal(page.kpis.status.NOT_SENT, 0);

    const exported = await ctx.service.exportOrders({ sort: 'orderCode', dir: 'desc' });
    assert.deepEqual(exported.map(o => [o.orderCode, o.warning]), [['HD002', false], ['HD001', true]]);

    const overridden = await ctx.service.overrideStatus('HD001', { code: 'CANCELLED', changedBy: 'A', changedByRole: 'Kế toán' });
    assert.equal(overridden.warning, false);
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// Đơn Bắc-Nam (tab DonHang_MienNam, 2026-10-12): đơn Kiot HN, chỉ 3 trạng thái, không cảnh báo 24h
// ---------------------------------------------------------------------------

function northSouthRecord(overrides) {
  return record(Object.assign({ orderCode: 'DH043419', _branch: 'HN', _flow: 'NORTH_SOUTH' }, overrides));
}

function kiotOrder(overrides) {
  return Object.assign({
    code: 'DH043419', branch: 'HN', saleName: 'Quan Nguyen', customerName: 'KH Minh Long',
    kiotStatus: 'Phiếu tạm', sellableValue: 1000, total: 2000, orderDate: '2020-01-01 08:00', note: ''
  }, overrides);
}

function mergeFor(service, records, kiotOrders, overrides) {
  return service.mergeRows({
    records,
    overrides: overrides || new Map(),
    kiotResult: { ok: true, orders: kiotOrders }
  });
}

test('đơn Bắc-Nam: gửi kế toán quá 24h chưa ký nhận -> "Chưa chụp bill tàu", không có cảnh báo lái xe như đơn HN', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const rows = mergeFor(ctx.service, [
      northSouthRecord({ saleSentAt: '01/01/2020 08:00', accountantApprovedOrderAt: '01/01/2020 08:10' }),
      record({ orderCode: 'DH000002', saleSentAt: '01/01/2020 08:00', accountantApprovedOrderAt: '01/01/2020 08:10' })
    ], [kiotOrder(), kiotOrder({ code: 'DH000002' })]);
    assert.deepEqual(rows.map(r => [r.orderCode, r.warnings]), [['DH043419', [W.NO_TRAIN_BILL]], ['DH000002', [W.DRIVER_NO_PHOTO]]]);
    assert.deepEqual(rows.map(r => r.warning), [true, true]);
  } finally {
    ctx.restore();
  }
});

test('đơn Bắc-Nam: chỉ 3 trạng thái — "Kế toán duyệt đơn" không đổi trạng thái, "Đơn đã ký nhận" -> Đã nhận (Đi giao xong)', () => {
  const ctx = freshService();
  try {
    const code = ctx.service.STATUS;
    const [none, sent, approved, signed] = mergeFor(ctx.service, [
      northSouthRecord({ orderCode: 'DH000001' }),
      northSouthRecord({ orderCode: 'DH000002', saleSentAt: '12/10/2026 08:52' }),
      northSouthRecord({ orderCode: 'DH000003', saleSentAt: '12/10/2026 08:52', accountantApprovedOrderAt: '12/10/2026 09:10' }),
      northSouthRecord({ orderCode: 'DH000004', saleSentAt: '12/10/2026 08:52', accountantApprovedOrderAt: '12/10/2026 09:10', orderSignedAt: '13/10/2026 08:00' })
    ], ['DH000001', 'DH000002', 'DH000003', 'DH000004'].map(c => kiotOrder({ code: c })));
    assert.equal(none.summary.code, code.NOT_SENT);
    assert.equal(sent.summary.code, code.SENT_TO_ACCOUNTANT);
    assert.equal(approved.summary.code, code.SENT_TO_ACCOUNTANT);
    assert.equal(approved.accountantApprovedOrderAt, '12/10/2026 09:10'); // vẫn có trong chi tiết
    assert.equal(signed.summary.code, code.SIGNED);
  } finally {
    ctx.restore();
  }
});

test('đơn Bắc-Nam: ghép với đơn Kiot HN (branch HN, Sale/Khách lấy từ Kiot); không có trên Kiot HN thì bị bỏ; không lọt sang SG', () => {
  const ctx = freshService();
  try {
    const rows = mergeFor(ctx.service, [
      northSouthRecord({ saleSentAt: '12/10/2026 08:52' }),
      northSouthRecord({ orderCode: 'DH999999', saleSentAt: '12/10/2026 08:52' })
    ], [kiotOrder(), kiotOrder({ code: 'DH043419', branch: 'SG', saleName: 'Khác' })]);
    const matched = rows.filter(r => r.orderCode === 'DH043419');
    const hn = matched.find(r => r.branch === 'HN');
    assert.equal(hn.source, 'sheet');
    assert.equal(hn.saleName, 'Quan Nguyen');
    assert.equal(hn.customerName, 'KH Minh Long');
    assert.equal(hn.saleSentAt, '12/10/2026 08:52');
    assert.equal(matched.find(r => r.branch === 'SG').source, 'kiotviet'); // đơn SG cùng mã chỉ là đơn Kiot SG thuần
    assert.equal(rows.some(r => r.orderCode === 'DH999999'), false);
  } finally {
    ctx.restore();
  }
});

test('đơn Bắc-Nam: ghi đè thủ công Đã hủy / Sự cố vẫn thắng', () => {
  const ctx = freshService();
  try {
    const overrides = new Map([['dh043419', { to_status_code: 'CANCELLED', changed_by: 'A', changed_at: '2026-10-12 10:00:00' }]]);
    const [row] = mergeFor(ctx.service, [northSouthRecord({ saleSentAt: '12/10/2026 08:52' })], [kiotOrder()], overrides);
    assert.equal(row.summary.code, ctx.service.STATUS.CANCELLED);
    assert.equal(row.warning, false);
  } finally {
    ctx.restore();
  }
});

test('Kế toán sót đơn CHỈ áp dụng khi trạng thái còn là "Đơn đã gửi kế toán": sang Đang giao / Đã nhận / Đã ký nhận thì bỏ cảnh báo', () => {
  const ctx = freshService();
  try {
    const W = ctx.service.WARNING;
    const stuck = { saleSentAt: '12/10/2026 10:00' };
    assert.deepEqual(warningsFor(ctx.service, record(stuck), '12/10/2026 11:00'), [W.ACCOUNTANT_LATE]);
    // Tai xe da gui xac nhan (Dang giao) du KT chua duyet o cot D
    assert.ok(!warningsFor(ctx.service, record(Object.assign({ driverConfirmedDeliveryAt: '12/10/2026 10:40' }, stuck)), '12/10/2026 11:00').includes(W.ACCOUNTANT_LATE));
    // Ship da nhan don / Don da ky nhan (chup bill ky nhan)
    assert.ok(!warningsFor(ctx.service, record(Object.assign({ shipReceivedAt: '12/10/2026 10:40' }, stuck)), '12/10/2026 11:00').includes(W.ACCOUNTANT_LATE));
    assert.ok(!warningsFor(ctx.service, record(Object.assign({ orderSignedAt: '12/10/2026 10:40' }, stuck)), '12/10/2026 11:00').includes(W.ACCOUNTANT_LATE));
    // Ghi de thu cong sang trang thai khac "Da gui ke toan"
    const rec = record(stuck);
    const sent = ctx.service.computeStatus(rec);
    assert.deepEqual(ctx.service.computeWarnings(rec, sent, Date.parse('2026-10-12T04:00:00Z')), [W.ACCOUNTANT_LATE]);
    for (const code of ['DELIVERING', 'DELIVERED', 'SHIP_RECEIVED', 'SIGNED']) {
      const summary = { code, label: code, isOverride: true };
      assert.ok(!ctx.service.computeWarnings(rec, summary, Date.parse('2026-10-12T04:00:00Z')).includes(W.ACCOUNTANT_LATE), code);
    }
  } finally {
    ctx.restore();
  }
});
