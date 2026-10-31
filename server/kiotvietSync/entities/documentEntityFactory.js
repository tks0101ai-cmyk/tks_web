'use strict';

const { value, array } = require('./entityUtils');
const { upsertStaffFromEntity } = require('../staffSync');

function createDocumentEntity(options) {
  const {
    entity, endpoint = entity, listQuery, hasUpperBound = true, parentColumns,
    parentUpdateColumns, mapParent, detailTable, parentIdColumn, detailKeys,
    detailColumns, mapDetail, payment, backfillRangeParam, batchDetails = false,
    // Payload khong co ten nhan vien (vd /ordersuppliers chi co userId) thi khong
    // upsert `staff` de khong sinh dong nhan vien rong ten.
    syncStaff = true,
    // Sap/bo sung item truoc khi ghi (vd orders: sap dong hang theo thu tu that cua Kiot). Fail-soft o phia goi.
    prepareItems = null
  } = options;
  const parentSql = `INSERT INTO ${entity} (${parentColumns.join(',')}) VALUES (${parentColumns.map((_, i) => `$${i + 1}`).join(',')})
    ON CONFLICT (branch, id) DO UPDATE SET ${parentUpdateColumns.map((c) => `${c}=EXCLUDED.${c}`).join(', ')}, raw=EXCLUDED.raw, synced_at=now()`;
  const detailSql = `INSERT INTO ${detailTable} (${detailColumns.join(',')}) VALUES (${detailColumns.map((_, i) => `$${i + 1}`).join(',')})`;

  return {
    entity, endpoint, listQuery, incrementalParam: 'lastModifiedFrom', hasUpperBound,
    ...(backfillRangeParam ? { backfillRangeParam } : {}),
    async upsertPage(pgClient, branch, items) {
      if (prepareItems) items = await prepareItems(branch, items);
      // Upsert "staff" (bang dung chung giua invoices/orders/returns/purchases)
      // MOT LAN cho ca trang, theo thu tu id tang dan, TRUOC khi ghi cac bang
      // rieng cua entity - phat hien deadlock that khi backfill production
      // (2026-09-16): 2 entity ghi dong thoi, moi giao dich upsert staff xen
      // ke theo thu tu item khac nhau -> thu tu khoa khong nhat quan giua 2
      // giao dich -> deadlock. Thu tu id co dinh giua moi giao dich la cach
      // chuan tranh deadlock kieu nay.
      const staffById = new Map();
      for (const item of syncStaff ? items : []) {
        const staffId = value(item, 'SoldById', 'soldById', 'CreatedById', 'createdById', 'UserId', 'userId', 'ReceivedById', 'receivedById');
        if (staffId === null || staffId === undefined || staffId === '') continue;
        if (!staffById.has(staffId)) {
          staffById.set(staffId, value(item, 'SoldByName', 'soldByName', 'CreatedByName', 'createdByName', 'UserName', 'userName', 'ReceivedByName', 'receivedByName'));
        }
      }
      for (const staffId of [...staffById.keys()].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))) {
        await upsertStaffFromEntity(pgClient, branch, staffId, staffById.get(staffId));
      }

      for (const item of items) {
        const parentValues = mapParent(item);
        const id = parentValues[0];
        await pgClient.query(parentSql, [branch, ...parentValues, item]);
        await pgClient.query(`DELETE FROM ${detailTable} WHERE branch=$1 AND ${parentIdColumn}=$2`, [branch, id]);
        const details = array(item, ...detailKeys);
        const batchSize = batchDetails ? 500 : 1;
        for (let start = 0; start < details.length; start += batchSize) {
          const rows = details.slice(start, start + batchSize).map((detail, i) =>
            [branch, id, start + i, ...mapDetail(detail), detail]);
          const placeholders = rows.map((row, i) =>
            `(${row.map((_, j) => `$${i * detailColumns.length + j + 1}`).join(',')})`);
          const sql = batchDetails
            ? `INSERT INTO ${detailTable} (${detailColumns.join(',')}) VALUES ${placeholders.join(',')}`
            : detailSql;
          await pgClient.query(sql, rows.flat());
        }
        if (payment) {
          await pgClient.query(`DELETE FROM ${payment.table} WHERE branch=$1 AND ${parentIdColumn}=$2`, [branch, id]);
          const payments = array(item, ...payment.keys);
          for (let lineNo = 0; lineNo < payments.length; lineNo++) {
            await pgClient.query(payment.sql, [branch, id, lineNo, ...payment.map(payments[lineNo]), payments[lineNo]]);
          }
        }
      }
    }
  };
}

module.exports = { createDocumentEntity, value };
