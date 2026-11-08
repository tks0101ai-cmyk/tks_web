'use strict';

// API ghi cua tab Cong no (2026-10-13, cong no theo lich TT — server/debtSchedule).
// Moi cot sua duoc co quyen rieng (featureRegistry):
//   Sale phan hoi  -> reports.debt.saleFeedback   (mac dinh Nhan vien sale)
//   QL phan hoi    -> reports.debt.managerFeedback (mac dinh Quan ly)
//   Trang thai     -> reports.debt.edit            (mac dinh Quan ly)
//   Lich TT        -> reports.debt.schedule        (mac dinh Quan ly)
// Tien phat luon tu tinh theo quy che (da bo phat tay 2026-11-02).
// Phan hoi/trang thai chi ghi vao chu ky hien tai (ban chot 15:00 moi nhat); client gui kem
// cycleDate dang xem, lech thi tra 409 de nguoi dung tai lai. Rieng trang thai co the sua ngay cu trong
// 7 ngay qua hop lich su cua khach (historical: true) — cac ngay sau tu tinh lai.

const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { BRANCH_BOTH, branchLabelToCode, resolveBranchScope } = require('../branch/branches');
const branchMiddleware = require('../branch/branchMiddleware');
const debtScheduleRepository = require('../debtSchedule/debtScheduleRepository');
const { WORKFLOW_STATUSES } = require('../debtSchedule/debtScheduleRules');

const CYCLE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function repository() {
  return debtScheduleRepository.getDebtScheduleRepository();
}

function readTarget(body) {
  const cycleDate = String(body?.cycleDate || '').trim();
  return {
    branch: String(body?.branch || '').trim(),
    customerId: String(body?.customerId || '').trim(),
    cycleDate: CYCLE_DATE.test(cycleDate) ? cycleDate : undefined
  };
}

function sendError(res, error, fallbackMessage, fallbackCode) {
  if (error && error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  console.error(`[DebtManagement] ${fallbackMessage}:`, error && error.message);
  return res.status(503).json({ error: fallbackMessage, code: fallbackCode });
}

function branchCodesFor(req) {
  return resolveBranchScope(req.branch || BRANCH_BOTH).map(branchLabelToCode).filter(Boolean);
}

function notifyDebtChange() {
  require('../kiotvietSync/dashboardRollupEvents').dashboardRollupEvents.emit('updated', { at: Date.now() });
}

const router = express.Router();

function feedbackRoute(path, field, feature) {
  router.patch(path, requireAuth, requireFeature(feature), async (req, res) => {
    try {
      const result = await repository().saveFeedback({
        ...readTarget(req.body), field, value: req.body?.value, user: req.user
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Không thể lưu phản hồi lúc này.', 'DEBT_FEEDBACK_UNAVAILABLE');
    }
  });
}

feedbackRoute('/api/debt-management/sale-feedback', 'sale', 'reports.debt.saleFeedback');
feedbackRoute('/api/debt-management/manager-feedback', 'manager', 'reports.debt.managerFeedback');

router.patch('/api/debt-management/status', requireAuth, requireFeature('reports.debt.edit'), async (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!WORKFLOW_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Trạng thái xử lý không hợp lệ.', code: 'INVALID_DEBT_STATUS' });
  }
  try {
    // historical: sua trang thai MOT NGAY CU trong hop lich su 7 ngay cua khach; cac ngay sau tu tinh lai.
    const target = readTarget(req.body);
    const result = req.body?.historical === true
      ? await repository().saveHistoricalStatus({ ...target, status, user: req.user })
      : await repository().saveStatus({ ...target, status, user: req.user });
    notifyDebtChange();
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'Không thể cập nhật trạng thái xử lý lúc này.', 'DEBT_STATUS_UNAVAILABLE');
  }
});

router.patch('/api/debt-management/schedule', requireAuth, requireFeature('reports.debt.schedule'), async (req, res) => {
  try {
    const { branch, customerId } = readTarget(req.body);
    const result = await repository().setSchedule({ branch, customerId, days: req.body?.scheduleDays, user: req.user });
    notifyDebtChange();
    // Lich TT doi -> Con han / No qua han cua bang Tuoi no doi: tinh lai nen, xong thi bao client.
    require('../debtSchedule/debtAgingRefresh').requestDebtAgingRefresh().then(aging => {
      if (aging && aging.changed) notifyDebtChange();
    });
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'Không thể lưu lịch thanh toán lúc này.', 'DEBT_SCHEDULE_UNAVAILABLE');
  }
});

// Tinh lai cong no tai thoi diem bam (2026-10-14): dong bo khach KiotViet roi ghi de chu ky dang
// mo (debtCycleSnapshot.refreshDebtCycle). 1 lan chay tai 1 thoi diem; loi dong bo khach thi
// van tinh voi no hien tai dang co trong DB.
let refreshRunning = false;

router.post('/api/debt-management/refresh', requireAuth, requireFeature('reports.debt.refresh'), async (req, res) => {
  if (refreshRunning) {
    return res.status(409).json({ error: 'Đang tính lại công nợ, vui lòng chờ.', code: 'DEBT_REFRESH_RUNNING' });
  }
  refreshRunning = true;
  try {
    const { syncCustomers } = require('../kiotvietSync/scheduler');
    const { refreshDebtCycle } = require('../debtSchedule/debtCycleSnapshot');
    let syncWarning = '';
    try {
      await syncCustomers();
    } catch (error) {
      syncWarning = 'Không đồng bộ được khách từ KiotViet, đã tính với nợ hiện tại đang có.';
      console.error('[DebtManagement] Dong bo khach truoc khi tinh lai loi:', error && error.message);
    }
    await require('../debtSchedule/debtPenaltyLedger').finalizePenaltyBeforeReset(require('../db/pool').getPool(),{beforeReset:true});
    const result = await refreshDebtCycle(require('../db/pool').getPool(), {
      userName: (req.user && (req.user.hoTen || req.user.username)) || ''
    });
    repository().bumpVersion();
    // Ban chot hom nay vua duoc tao -> chot so phat cua chu ky truoc, nhu job 15:00.
    if (result.created) {
      await require('../debtSchedule/debtRewardClosing').settleDebtRewards(require('../db/pool').getPool())
        .catch(error => console.error('[DebtManagement] Chot thuong/phat loi, se thu lai:', error && error.message));
    }
    // Bao cac trinh duyet dang mo SSE (tai khoan khac) tu tai lai so cong no moi.
    require('../kiotvietSync/dashboardRollupEvents').dashboardRollupEvents.emit('updated', { at: Date.now() });
    return res.status(200).json({ ...result, warning: syncWarning });
  } catch (error) {
    return sendError(res, error, 'Không thể tính lại công nợ lúc này.', 'DEBT_REFRESH_UNAVAILABLE');
  } finally {
    refreshRunning = false;
  }
});

// Lich su sua Sale phan hoi / QL phan hoi cua chu ky hien tai (reset cung ban chot 15:00).
router.get('/api/debt-management/feedback-history', requireAuth, requireFeature('reports.debt'),
  branchMiddleware.resolveBranch, async (req, res) => {
    try {
      return res.json(await repository().listFeedbackHistory({ branches: branchCodesFor(req) }));
    } catch (error) {
      return sendError(res, error, 'Không thể tải lịch sử chỉnh sửa lúc này.', 'DEBT_HISTORY_UNAVAILABLE');
    }
  });

// Lich su 7 ngay cua 1 khach (hop mo khi bam dong o "Danh sach thao tac").
router.get('/api/debt-management/customer-history', requireAuth, requireFeature('reports.debt'),
  branchMiddleware.resolveBranch, async (req, res) => {
    try {
      const branch = String(req.query?.branch || '').trim();
      if (!branchCodesFor(req).includes(branch)) {
        return res.status(403).json({ error: 'Bạn không có quyền xem cơ sở này.', code: 'BRANCH_FORBIDDEN' });
      }
      return res.json(await repository().listCustomerHistory({ branch, customerId: req.query?.customerId }));
    } catch (error) {
      return sendError(res, error, 'Không thể tải lịch sử công nợ của khách lúc này.', 'DEBT_CUSTOMER_HISTORY_UNAVAILABLE');
    }
  });

// Shared server calculation: global HN+SG ranking and pool, branch filtering only after ranking.
router.get('/api/debt-management/penalty-board', requireAuth, requireFeature('reports.debt'),
  branchMiddleware.resolveBranch, async (req, res) => {
    try {
      const board = await require('../debtSchedule/debtRewardService').getDebtRewardService()
        .readBoard({ month: req.query?.month, branches: branchCodesFor(req) });
      return res.json(board);
    } catch (error) {
      return sendError(res, error, 'Không thể tải bảng phạt sale lúc này.', 'DEBT_PENALTY_BOARD_UNAVAILABLE');
    }
  });

// Bang tuoi no theo hoa don (muc 3): so song theo lan dong bo KiotViet moi nhat, khong theo ban chot 15:00.
router.get('/api/debt-management/aging', requireAuth, requireFeature('reports.debt'),
  branchMiddleware.resolveBranch, async (req, res) => {
    try {
      const data = await require('../debtSchedule/debtScheduleService').buildDebtAging(branchCodesFor(req));
      return res.json(require('../shared/tablePage').wantsPage(req.query) ? require('../debtSchedule/debtAgingRepository').queryDebtAging(data, req.query) : data);
    } catch (error) {
      return sendError(res, error, 'Không thể tải bảng tuổi nợ lúc này.', 'DEBT_AGING_UNAVAILABLE');
    }
  });

// Hop chi tiet 1 dong Kiem tra cong no: hoa don trong khoang ngay no tuong duong cua khach.
router.get('/api/debt-management/aging/invoices', requireAuth, requireFeature('reports.debt'),
  branchMiddleware.resolveBranch, async (req, res) => {
    try {
      return res.json(await require('../debtSchedule/debtScheduleService')
        .buildDebtAgingInvoices(branchCodesFor(req), { branch: req.query?.branch, customerId: req.query?.customerId }));
    } catch (error) {
      return sendError(res, error, 'Không thể tải hóa đơn của khách lúc này.', 'DEBT_AGING_INVOICES_UNAVAILABLE');
    }
  });

// Nhat ky sua lich TT (giu vinh vien). Co branch + customerId thi loc theo 1 khach.
router.get('/api/debt-management/schedule-log', requireAuth, requireFeature('reports.debt'), async (req, res) => {
  try {
    const branch = String(req.query.branch || '').trim();
    const customerId = String(req.query.customerId || '').trim();
    const entries = await repository().listScheduleLog(branch && customerId ? { branch, customerId } : {});
    return res.json({ entries });
  } catch (error) {
    return sendError(res, error, 'Không thể tải nhật ký lịch thanh toán lúc này.', 'DEBT_SCHEDULE_LOG_UNAVAILABLE');
  }
});

// Cac ban chot con luu (7 ngay gan nhat, moi nhat truoc) de hop thoai Xuat file chon chu ky.
router.get('/api/debt-management/cycles', requireAuth, requireFeature('reports.export'), async (req, res) => {
  try {
    return res.json({ cycles: await repository().listCycles() });
  } catch (error) {
    return sendError(res, error, 'Không thể tải danh sách bản chốt công nợ lúc này.', 'DEBT_CYCLES_UNAVAILABLE');
  }
});

module.exports = router;
module.exports.WORKFLOW_STATUSES = WORKFLOW_STATUSES;
