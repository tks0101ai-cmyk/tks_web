'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createManagerLeaveStore } = require('./managerLeaveStore');
const { createHrLeaveRepository } = require('../hr/hrLeaveRepository');
const { createManagerLeaveRuntime } = require('./managerLeaveRuntime');

test('real DB complete workflow: scoped backlog, Telegram rejection, duplicate updates, web reopening', async () => {
  const db = new PGlite();
  const managers = ['Hà Nội', 'Sài Gòn', 'Cả hai', ''].map((coSo, i) => ({
    id: `${i + 1}1111111-1111-1111-1111-111111111111`, telegramId: `${100 + i}`,
    username: `manager${i}`, hoTen: `Quản lý ${i}`, vaiTro: 'Quản lý', trangThai: 'Đang hoạt động', leaveApprovalDepartments:['Kho'],assignedCoSo:coSo,coSo
  }));
  try {
    await db.exec(`CREATE ROLE reporting_readonly;
      CREATE TABLE hr_employees(id BIGINT PRIMARY KEY, bo_phan TEXT);
      CREATE TABLE app_users(id UUID PRIMARY KEY, username TEXT, vai_tro TEXT DEFAULT 'Quản lý',feature_permissions JSONB DEFAULT '{}'::jsonb, is_deleted BOOLEAN DEFAULT false,
        telegram_id TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT now(), hr_employee_id BIGINT);`);
    for (const user of managers) await db.query('INSERT INTO app_users(id, username) VALUES ($1, $2)', [user.id, user.username]);
    for (const name of ['0016_hr_leave_telegram.sql', '0029_hr_manager_telegram.sql', '0030_drop_leave_provisional_status.sql', '0031_hr_leave_approval_scope.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8'));
    for (const [requestId, branch, status, type] of [
      ['NP-HN', 'hanoi', 'Chưa duyệt', 'Xin nghỉ phép'], ['NP-SG', 'saigon', 'Chưa duyệt', 'Xin nghỉ phép'],
      ['NP-CLOSED', 'hanoi', 'Đã duyệt', 'Xin nghỉ phép'], ['NP-MANUAL', 'hanoi', 'Đã duyệt', 'Tự ý nghỉ (HR ghi nhận)']
    ]) await db.query(`INSERT INTO hr_leave_requests(request_id,bo_phan,branch,start_date,start_session,end_date,end_session,tong_buoi_nghi,trang_thai,loai_yeu_cau)
      VALUES ($1,'Kho',$2,'2026-10-02','Sáng','2026-10-02','Chiều',2,$3,$4)`, [requestId, branch, status, type]);
    const pool = { query: (sql, values) => db.query(sql, values), connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) };
    await db.exec("ALTER TABLE hr_employees ADD COLUMN branch TEXT DEFAULT 'hanoi',ADD COLUMN is_active BOOLEAN DEFAULT true; INSERT INTO hr_employees(id,bo_phan) VALUES(1,'Kho'); ALTER TABLE app_users ADD COLUMN trang_thai TEXT DEFAULT 'Đang hoạt động'");
    await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0038_hr_leave_deadlines.sql'),'utf8'));
    await db.exec("ALTER TABLE hr_leave_requests ALTER COLUMN hr_employee_id SET DEFAULT 1; INSERT INTO hr_leave_work_schedules(employee_id,work_date,morning_start,afternoon_start) VALUES(1,'2026-10-02','08:15','13:00')");
    for(const name of ['0093_notifications.sql','0094_hr_leave_cancellation.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
    const store = createManagerLeaveStore({ pool });
    const leaveRepo = createHrLeaveRepository({ pool });
    const calls = [];
    const notifications = [];
    let messageId = 0;
    let failListCardId;
    const makeRuntime = () => createManagerLeaveRuntime({ store, leaveRepo,
      telegram: { call: async (method, params) => { calls.push({ method, params }); if(method==='editMessageText' && String(params.message_id)===String(failListCardId))throw Object.assign(new Error('temporary network'),{code:'TELEGRAM_UNAVAILABLE'}); return { message_id: ++messageId }; } },
      getManager: async id => managers.find(m => m.telegramId === String(id)), loadManagers: async () => managers,
      notifyDecision: async record => notifications.push(record.request_id), webUrl: 'https://example.com',
      backlogIntervalMs: 0, // test kiem backlog duoc quet lai moi luot khi pham vi quan ly doi
      logger: { error() {} }
    });
    let runtime = makeRuntime();
    await runtime.drain();
    assert.equal(calls.filter(c => c.method === 'sendMessage').length, 4, 'closed history and manual absences are not replayed');
    const deliveries = (await db.query('SELECT * FROM hr_leave_manager_messages')).rows;
    assert.deepEqual(deliveries.filter(d => d.request_id === 'NP-HN').map(d => d.telegram_chat_id).sort(), ['100', '102']);
    assert.deepEqual(deliveries.filter(d => d.request_id === 'NP-SG').map(d => d.telegram_chat_id).sort(), ['101', '102']);
    // A genuinely new request can be approved on web before its CREATE job
    // drains. Managers still receive its result, with Telegram actions locked.
    await db.query(`INSERT INTO hr_leave_requests(request_id,bo_phan,branch,start_date,start_session,end_date,end_session,tong_buoi_nghi,trang_thai)
      VALUES ('NP-NEW-FINAL','Kho','hanoi','2026-10-02','Sáng','2026-10-02','Chiều',2,'Đã duyệt')`);
    await db.query("UPDATE hr_leave_requests SET trang_thai='Đã duyệt' WHERE request_id='NP-NEW-FINAL'");
    const callsBeforeFresh = calls.length;
    await runtime.drain();
    // Tin nhắn không còn in mã yêu cầu, nên nhận diện thẻ mới theo lượt gửi sau lần quét trước.
    const freshCards = calls.slice(callsBeforeFresh).filter(c => c.method === 'sendMessage');
    assert.equal(freshCards.length, 2, 'new finalized request is sent even before first scan');
    assert.ok(freshCards.every(c => !c.params.reply_markup.inline_keyboard.flat().some(b => b.callback_data)));
    let updateId = 1;
    const sendAction = async (user, requestId, version, code) => {
      const delivery = await store.getDelivery(requestId, user.id, user.telegramId);
      const update = { update_id: updateId++, callback_query: { id: `q${updateId}`, from: { id: Number(user.telegramId) },
        message: { message_id: Number(delivery.message_id), chat: { id: Number(user.telegramId), type: 'private' } }, data: `d|${requestId}|${version}|${code}` } };
      assert.equal(await store.enqueueUpdate(update), true);
      assert.equal(await store.enqueueUpdate(update), false);
      await runtime.drain();
    };
    await sendAction(managers[0], 'NP-HN', '0', 't');
    let row = await leaveRepo.getLeaveRequestById('NP-HN', 'Hà Nội');
    assert.equal(row.trang_thai, 'Chưa duyệt', 'removed Telegram actions cannot decide');
    assert.equal(row.decision_version, '0');
    // Simulate a pre-0038 external writer's legacy approval value. New web writes reject it.
    await db.query("UPDATE hr_leave_requests SET trang_thai='Vi phạm',nguoi_duyet='Legacy' WHERE request_id='NP-HN'");
    await runtime.drain();
    row = await leaveRepo.getLeaveRequestById('NP-HN', 'Hà Nội');
    assert.equal(row.trang_thai, 'Vi phạm');
    assert.equal(row.decision_version, '1');
    await sendAction(managers[2], 'NP-HN', '0', 'r');
    assert.equal(await store.getSession('102'), null, 'stale callback cannot start a rejection');
    await sendAction(managers[0], 'NP-HN', '1', 'r');
    const session = await store.getSession('100');
    assert.ok(session.prompt_message_id);
    assert.equal((await leaveRepo.getLeaveRequestById('NP-HN', 'Hà Nội')).trang_thai, 'Vi phạm');
    runtime = makeRuntime(); // Restart between requesting a reason and replying.
    await store.enqueueUpdate({ update_id: updateId++, message: { from: { id: 100 }, chat: { id: 100, type: 'private' },
      text: '  Thiếu người trực  ', reply_to_message: { message_id: Number(session.prompt_message_id) } } });
    await runtime.drain();
    row = await leaveRepo.getLeaveRequestById('NP-HN', 'Hà Nội');
    assert.equal(row.trang_thai, 'Từ chối');
    assert.equal(row.ghi_chu_duyet, `Người duyệt: ${managers[0].hoTen} - ${managers[0].vaiTro}\nLý do từ chối: Thiếu người trực`);
    assert.equal(row.decision_version, '2');
    assert.equal(row.nguoi_duyet, managers[0].hoTen);
    assert.equal(await store.getSession('100'), null);
    await sendAction(managers[2], 'NP-HN', '2', 'a');
    assert.equal((await leaveRepo.getLeaveRequestById('NP-HN', 'Hà Nội')).decision_version, '2', 'final decisions cannot be overwritten by Telegram');
    await leaveRepo.updateLeaveRequestStatus('NP-HN', { status: 'Chưa duyệt', approver: 'Web',expectedVersion:'2' }, 'Hà Nội');
    await runtime.drain();
    const lastEdit = calls.filter(c => c.method === 'editMessageText').at(-1);
    assert.ok(lastEdit.params.reply_markup.inline_keyboard.some(row => row.some(button => button.callback_data === 'd|NP-HN|3|a')));
    assert.deepEqual(notifications, ['NP-HN']);
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM hr_manager_telegram_updates WHERE completed_at IS NULL')).rows[0].n, 0);
    // /donnghi cards have their own ownership record; notification leases remain intact.
    const original=await store.getDelivery('NP-SG',managers[1].id,'101');
    await store.enqueueUpdate({update_id:updateId++,message:{from:{id:101},chat:{id:101,type:'private'},text:'/donnghi'}});
    await runtime.drain();
    const list=calls.filter(c=>c.method==='sendMessage' && c.params.text.includes('Trang 1/')).at(-1);
    assert.ok(list.params.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='o|NP-SG|0'));
    await store.enqueueUpdate({update_id:updateId++,callback_query:{id:'open-list',from:{id:101},message:{message_id:999,chat:{id:101,type:'private'}},data:'o|NP-SG|0'}});
    await runtime.drain();
    const card=(await db.query("SELECT * FROM hr_manager_telegram_cards WHERE request_id='NP-SG'")).rows[0];
    assert.ok(card.message_id);assert.equal((await store.getDelivery('NP-SG',managers[1].id,'101')).message_id,original.message_id);
    await store.enqueueUpdate({update_id:updateId++,callback_query:{id:'approve-list',from:{id:101},message:{message_id:Number(card.message_id),chat:{id:101,type:'private'}},data:'d|NP-SG|0|a'}});
    await runtime.drain();
    assert.equal((await leaveRepo.getLeaveRequestById('NP-SG','Sài Gòn')).trang_thai,'Đã duyệt');
    const locked=calls.filter(call=>call.method==='editMessageText' && String(call.params.message_id)===String(card.message_id)).at(-1);
    assert.ok(locked,'list card refreshes after final decision');
    assert.ok(locked.params.reply_markup.inline_keyboard.flat().every(button=>!button.callback_data && !button.web_app));
    assert.equal((await db.query("SELECT expected_version::text FROM hr_manager_telegram_cards WHERE request_id='NP-SG'")).rows[0].expected_version,'1');
    failListCardId=String(card.message_id);
    await leaveRepo.updateLeaveRequestStatus('NP-SG',{status:'Chưa duyệt',approver:'Web',expectedVersion:'1'},'Sài Gòn');
    await runtime.drain();
    assert.equal((await db.query("SELECT expected_version::text FROM hr_manager_telegram_cards WHERE request_id='NP-SG'")).rows[0].expected_version,'1','failed refresh remains pending');
    assert.ok((await db.query("SELECT id FROM hr_leave_change_events WHERE request_id='NP-SG' AND completed_at IS NULL")).rows.length);
    failListCardId=undefined;await db.query("UPDATE hr_leave_change_events SET available_at=now() WHERE request_id='NP-SG'");await runtime.drain();
    const reopened=calls.filter(call=>call.method==='editMessageText' && String(call.params.message_id)===String(card.message_id)).at(-1);
    assert.ok(reopened.params.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='d|NP-SG|2|a'));
    assert.equal((await db.query("SELECT expected_version::text FROM hr_manager_telegram_cards WHERE request_id='NP-SG'")).rows[0].expected_version,'2');
    // A card persisted after its event completed is reconciled on the next drain.
    await store.recordDeliveryMessage({requestId:'NP-SG',userId:managers[1].id,chatId:'101',version:'1',messageId:'20000'});
    await runtime.drain();
    const reconciled=calls.filter(call=>call.method==='editMessageText' && String(call.params.message_id)==='20000').at(-1);
    assert.ok(reconciled.params.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='d|NP-SG|2|a'));
    // A recipient whose permission scope was removed gets only keyboard removal.
    managers[1].leaveApprovalDepartments=[];
    await leaveRepo.updateLeaveRequestStatus('NP-SG',{status:'Chưa duyệt',approver:'Web',expectedVersion:'2'},'Sài Gòn');await runtime.drain();
    assert.ok(calls.some(call=>call.method==='editMessageReplyMarkup' && String(call.params.message_id)===String(card.message_id) && call.params.reply_markup.inline_keyboard.length===0));
    managers[1].leaveApprovalDepartments=['Kho'];
    // Permission granted later must recover an initially unroutable violation request.
    await db.exec("INSERT INTO hr_employees(id,bo_phan,branch) VALUES(2,'Kế toán','saigon'); INSERT INTO hr_leave_work_schedules(employee_id,work_date,morning_start,afternoon_start) VALUES(2,'2026-10-02','08:15','13:00')");
    await db.query(`INSERT INTO hr_leave_requests(request_id,hr_employee_id,bo_phan,branch,start_date,start_session,end_date,end_session,tong_buoi_nghi,trang_thai)
      VALUES ('NP-VIOLATION',2,'Kế toán','saigon','2026-10-02','Sáng','2026-10-02','Chiều',2,'Vi phạm')`);
    await runtime.drain();assert.equal((await db.query("SELECT id FROM hr_leave_manager_messages WHERE request_id='NP-VIOLATION'")).rows.length,0);
    const callsBeforeViolation=calls.length;
    managers[1].leaveApprovalDepartments.push('Kế toán');await runtime.drain();
    assert.equal((await db.query("SELECT id FROM hr_leave_manager_messages WHERE request_id='NP-VIOLATION'")).rows.length,1);
    assert.ok(calls.slice(callsBeforeViolation).some(call=>call.method==='sendMessage'));

    assert.equal((await db.query('SELECT COUNT(*)::int n FROM hr_manager_telegram_updates WHERE completed_at IS NULL')).rows[0].n,0);

  } finally { await db.close(); }
});
