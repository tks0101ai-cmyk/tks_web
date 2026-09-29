'use strict';
const CONFIG = require('../../config');
const productOnHands = require('./productOnHands');

// Quet TOAN BO /productOnHands (khong loc lastModifiedFrom) dinh ky de ton kho
// khong the lech qua ~10 phut so voi KiotViet, ke ca khi `modifiedDate` cua API
// khong bump theo ban/nhap hang (xem ghi chu trong productOnHands.js). Dung
// cung upsertPage (gop theo branchId + chi UPDATE dong doi) nen quet nhieu lan
// gan nhu khong ton WAL. Checkpoint rieng 'product_on_hands_snapshot';
// `minIntervalMs` de syncDriver bo qua khi lan quet truoc con moi — nhom fast
// chay day hon nhieu (2-7 phut) va toan bo danh sach Ha Noi la ~108 request.
module.exports = {
  ...productOnHands,
  entity: 'product_on_hands_snapshot',
  pollFullSnapshot: true,
  minIntervalMs: CONFIG.KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS
};
