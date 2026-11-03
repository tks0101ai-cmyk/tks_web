'use strict';

// Tin hieu "dot kiem ke X vua doi" (khong kem du lieu), cung bus voi VT Ha Noi / dashboard.
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');

const CHANGED = 'stocktake-changed';

function announceChanged(sessionId) {
  dashboardRollupEvents.emit(CHANGED, { sessionId: Number(sessionId) });
}

module.exports = { events: dashboardRollupEvents, CHANGED, announceChanged };
