'use strict';

// Tin hieu "dot kiem ke X vua doi" (khong kem du lieu), cung bus voi VT Ha Noi / dashboard.
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');

const CHANGED = 'stocktake-changed';

// by: ma trinh duyet vua ghi (neu co) — trinh duyet do bo qua tin hieu cua chinh minh.
function announceChanged(sessionId, by) {
  dashboardRollupEvents.emit(CHANGED, { sessionId: Number(sessionId), by: by || '' });
}

module.exports = { events: dashboardRollupEvents, CHANGED, announceChanged };
