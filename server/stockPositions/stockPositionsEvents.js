'use strict';

// Tin hieu "bang vi tri cua co so X vua doi" (khong kem du lieu). Dung chung bus voi dashboard
// (kiotvietSync/dashboardRollupEvents.js) de job chay o worker.js cung toi duoc web qua cau Postgres NOTIFY.
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');

const CHANGED = 'stock-positions-changed';

function announceChanged(branch) {
  dashboardRollupEvents.emit(CHANGED, { branch });
}

module.exports = { events: dashboardRollupEvents, CHANGED, announceChanged };
