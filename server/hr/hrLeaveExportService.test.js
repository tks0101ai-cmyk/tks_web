'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const repo = require('./hrLeaveRepository');
const { buildLeaveRequestsWorkbook } = require('./hrLeaveExportService');
const { BRANCHES } = require('../branch/branches');

async function withFakeLeaveRequests(items, fn) {
  const original = repo.getLeaveRequests;
  repo.getLeaveRequests = async () => items;
  try {
    await fn();
  } finally {
    repo.getLeaveRequests = original;
  }
}
test('Excel export keeps independent timing and deadline after approval',async()=>{
 await withFakeLeaveRequests([{request_id:'R1',trang_thai:'Đã duyệt',timing_status:'Vi phạm',registration_deadline_date:'2026-10-04'}],async()=>{
  const {buffer}=await buildLeaveRequestsWorkbook({},BRANCHES.HANOI);const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);const sheet=workbook.worksheets[0],headers=sheet.getRow(1).values.slice(1);
  assert.equal(sheet.getRow(2).getCell(headers.indexOf('Thời hạn đăng ký')+1).value,'Vi phạm');assert.equal(sheet.getRow(2).getCell(headers.indexOf('Hạn đăng ký')+1).value,'2026-10-04');
 });
});

test('buildLeaveRequestsWorkbook: header freeze, khong to mau, chu den, an gridline, full border', async () => {
  await withFakeLeaveRequests([{ request_id: 'R1', ho_ten: 'Nguyễn Văn A' }], async () => {
    const { buffer, fileName } = await buildLeaveRequestsWorkbook({}, BRANCHES.HANOI);
    assert.match(fileName, /^HN_nghi-phep_/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 1);
    assert.equal(sheet.views[0].showGridLines, false);

    const header = sheet.getRow(1);
    assert.equal(header.font.color.argb, 'FF000000');
    header.eachCell(cell => {
      assert.equal(cell.fill === undefined || cell.fill.pattern === 'none', true);
      assert.ok(cell.border && cell.border.top && cell.border.left && cell.border.bottom && cell.border.right);
    });

    const dataRow = sheet.getRow(2);
    dataRow.eachCell(cell => {
      assert.ok(cell.border && cell.border.top && cell.border.left && cell.border.bottom && cell.border.right);
    });
  });
});

test('buildLeaveRequestsWorkbook: ten file gan tien to SG_ cho co so Sai Gon', async () => {
  await withFakeLeaveRequests([], async () => {
    const { fileName } = await buildLeaveRequestsWorkbook({}, BRANCHES.SAIGON);
    assert.match(fileName, /^SG_nghi-phep_/);
  });
});

test('buildLeaveRequestsWorkbook: nhiều cơ sở dùng tiền tố TKS_, có cột Cơ sở/Phòng ban, chuyển bộ lọc phòng ban', async () => {
  const original = repo.getLeaveRequests;
  let received;
  repo.getLeaveRequests = async (filters, branch) => {
    received = { filters, branch };
    return [{ request_id: 'R1', co_so: 'Sài Gòn', bo_phan: 'KHO' }];
  };
  try {
    const { buffer, fileName } = await buildLeaveRequestsWorkbook({ department: 'KHO' }, [BRANCHES.HANOI, BRANCHES.SAIGON]);
    assert.match(fileName, /^TKS_nghi-phep_/);
    assert.equal(received.filters.department, 'KHO');
    assert.deepEqual(received.branch, [BRANCHES.HANOI, BRANCHES.SAIGON]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    const headers = sheet.getRow(1).values.slice(1);
    const coSoCol = headers.indexOf('Cơ sở') + 1;
    const boPhanCol = headers.indexOf('Phòng ban') + 1;
    assert.ok(coSoCol > 0 && boPhanCol > 0);
    assert.equal(sheet.getRow(2).getCell(coSoCol).value, 'Sài Gòn');
    assert.equal(sheet.getRow(2).getCell(boPhanCol).value, 'KHO');

    const single = await buildLeaveRequestsWorkbook({}, [BRANCHES.SAIGON]);
    assert.match(single.fileName, /^SG_nghi-phep_/);
  } finally {
    repo.getLeaveRequests = original;
  }
});

test('leave export follows multiple priority levels, calendar sessions and null-last in descending', async () => {
  await withFakeLeaveRequests([
    {request_id:'B',ho_ten:'Same',thoi_gian_bat_dau:'Sáng 30/09/2026'},
    {request_id:'A',ho_ten:'Same',thoi_gian_bat_dau:'Chiều 01/10/2026'},
    {request_id:'C',ho_ten:'Same',thoi_gian_bat_dau:''}
  ],async()=>{
    const {buffer}=await buildLeaveRequestsWorkbook({sorts:[{field:'ho_ten',dir:'asc'},{field:'thoi_gian_bat_dau',dir:'desc'}]},BRANCHES.HANOI);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
    const sheet=workbook.worksheets[0],header=sheet.getRow(1).values.slice(1);
    const requestColumn=repo.LEAVE_SCHEMA_FIELD_KEYS.indexOf('request_id')+1;
    assert.deepEqual([2,3,4].map(row=>sheet.getRow(row).getCell(requestColumn).value),['A','B','C']);
  });
});
