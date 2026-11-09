'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createManagerLeaveStore } = require('./managerLeaveStore');
const { createHrLeaveRepository } = require('../hr/hrLeaveRepository');

const USER = '11111111-1111-1111-1111-111111111111';
const CHAT = '9007199254740993';

async function fixture() {
  const db = new PGlite();
  try {
  await db.exec(`CREATE ROLE reporting_readonly;
    CREATE TABLE hr_employees(id BIGINT PRIMARY KEY, bo_phan TEXT);
    CREATE TABLE app_users(id UUID PRIMARY KEY, username TEXT, vai_tro TEXT DEFAULT 'Quản lý',feature_permissions JSONB DEFAULT '{}'::jsonb, is_deleted BOOLEAN DEFAULT false,
      telegram_id TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ DEFAULT now(), hr_employee_id BIGINT);
    INSERT INTO app_users(id, username) VALUES ('${USER}', 'manager');`);
  for (const name of ['0016_hr_leave_telegram.sql', '0029_hr_manager_telegram.sql', '0030_drop_leave_provisional_status.sql', '0031_hr_leave_approval_scope.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8'));
  }
  await db.exec(`INSERT INTO hr_leave_requests(request_id, branch, start_date, start_session,
    end_date, end_session, tong_buoi_nghi) VALUES ('NP-TEST', 'hanoi', '2026-10-02', 'Sáng', '2026-10-02', 'Chiều', 2);`);
  await db.exec("ALTER TABLE hr_employees ADD COLUMN branch TEXT DEFAULT 'hanoi', ADD COLUMN is_active BOOLEAN DEFAULT true; INSERT INTO hr_employees(id,bo_phan) VALUES(1,'KHO'); ALTER TABLE app_users ADD COLUMN trang_thai TEXT DEFAULT 'Đang hoạt động'");
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0038_hr_leave_deadlines.sql'),'utf8'));
  await db.exec("ALTER TABLE hr_leave_requests ALTER COLUMN hr_employee_id SET DEFAULT 1; INSERT INTO hr_leave_work_schedules(employee_id,work_date,morning_start,afternoon_start) VALUES(1,'2026-10-02','08:15','13:00')");
  for(const name of ['0093_notifications.sql','0094_hr_leave_cancellation.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
  let releases = 0;
  const pool = { query: (sql, params) => db.query(sql, params), async connect() {
    return { query: (sql, params) => db.query(sql, params), release() { releases += 1; } };
  } };
  return { db, pool, store: createManagerLeaveStore({ pool }), releases: () => releases };
  } catch (error) { await db.close(); throw error; }
}

test('cancellation queue leases, retries and cleans completed payloads without a live request',async()=>{
 const {db,store}=await fixture();try{
  await db.exec("INSERT INTO hr_leave_cancellation_jobs(request_id,kind,telegram_chat_id,text) VALUES('gone','notify','123','Đã hủy')");
  const [job]=await store.claimCancellations();assert.equal(job.request_id,'gone');assert.equal((await store.claimCancellations()).length,0);
  assert.equal(await store.retryCancellation(job,{message:'temporary',retryAfter:1}),true);
  await db.exec("UPDATE hr_leave_cancellation_jobs SET available_at=now()-interval '1 second'");
  const [retry]=await store.claimCancellations();assert.equal(retry.attempts,2);assert.notEqual(retry.lease_token,job.lease_token);
  await store.completeCancellation(job);assert.equal((await db.query('SELECT count(*)::int n FROM hr_leave_cancellation_jobs')).rows[0].n,1);
  await store.completeCancellation(retry);assert.equal((await db.query('SELECT count(*)::int n FROM hr_leave_cancellation_jobs')).rows[0].n,0);
  await assert.rejects(store.withRequestLock('gone',async()=>{throw new Error('rollback');}),/rollback/);
 }finally{await db.close();}
});

test('activation refreshes delivered open cards without replaying final cards or unblocking recipients', async () => {
  const { db, store } = await fixture();
  try {
    await store.activate();
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '0' });
    const [job] = await store.claimDeliveries();
    await store.finishDelivery(job, { messageId: '10', version: '0' });
    assert.deepEqual(await store.claimDeliveries(), []);
    await store.activate();
    const [refresh] = await store.claimDeliveries();
    assert.ok(refresh, 'existing cards must receive the current keyboard after restart');
    assert.equal(refresh.message_id, '10');
    await store.finishDelivery(refresh, { messageId: '10', version: '0' });
    await db.exec("UPDATE hr_leave_requests SET trang_thai = 'Đã duyệt' WHERE request_id = 'NP-TEST'");
    await store.activate();
    assert.deepEqual(await store.claimDeliveries(), []);
    await db.exec("UPDATE hr_leave_requests SET trang_thai = 'Chưa duyệt' WHERE request_id = 'NP-TEST'; UPDATE hr_leave_manager_messages SET blocked = true");
    await store.activate();
    assert.equal((await db.query('SELECT blocked FROM hr_leave_manager_messages')).rows[0].blocked, true);
    assert.deepEqual(await store.claimDeliveries(), []);
  } finally { await db.close(); }
});

test('update inbox deduplicates and commits decision plus effects atomically; retries never reapply decisions', async () => {
  const { db, store, releases } = await fixture();
  try {
    assert.equal(await store.enqueueUpdate({ update_id: '9007199254740993', message: { text: 'Approve' } }), true);
    assert.equal(await store.enqueueUpdate({ update_id: '9007199254740993', message: { text: 'Different duplicate' } }), false);
    const [job] = await store.claimUpdates();
    assert.equal(job.update_id, '9007199254740993');
    assert.equal(job.attempts, 1);
    let invocations = 0;
    const effects = await store.handleUpdate(job, async ({ store: txnStore, leaveRepo }) => {
      invocations += 1;
      await leaveRepo.updateLeaveRequestStatus('NP-TEST', { status: 'Đã duyệt', expectedVersion: '0', lockFinal: true }, 'Hà Nội');
      await txnStore.saveSession({ chatId: CHAT, userId: USER, requestId: 'NP-TEST', expectedVersion: '1' });
      return [{ type: 'message', chatId: CHAT, text: 'Approved' }];
    });
    assert.deepEqual(effects, [{ type: 'message', chatId: CHAT, text: 'Approved' }]);
    const state = (await db.query('SELECT trang_thai, decision_version::text FROM hr_leave_requests')).rows[0];
    assert.deepEqual(state, { trang_thai: 'Đã duyệt', decision_version: '1' });
    assert.equal((await db.query('SELECT count(*)::int AS total FROM hr_leave_change_events')).rows[0].total, 2);
    await store.retryUpdate(job, new Error('Telegram unavailable'), 1);
    await db.exec("UPDATE hr_manager_telegram_updates SET available_at = now() - interval '1 second'");
    const [retry] = await store.claimUpdates();
    assert.ok(retry.handled_at);
    assert.notEqual(retry.lease_token, job.lease_token);
    assert.deepEqual(await store.handleUpdate(retry, async () => { invocations += 1; return []; }), effects);
    assert.equal(invocations, 1);
    assert.equal(await store.completeEffect(job, 1), false, 'an old process cannot checkpoint the new lease');
    assert.equal(await store.retryUpdate(job, new Error('stale process'), 1), false);
    assert.equal(await store.completeUpdate(retry), false, 'pending effects prevent completion');
    assert.equal(await store.completeEffect(retry, 1), true);
    assert.equal(await store.completeEffect(retry, 0), true, 'checkpoint cannot regress');
    assert.equal(await store.completeUpdate(retry), true);
    assert.deepEqual(await store.claimUpdates(), []);
    assert.ok(releases() >= 2);
  } finally { await db.close(); }
});

test('failed update handling rolls back decision, event and session together', async () => {
  const { db, store } = await fixture();
  try {
    await store.enqueueUpdate({ update_id: 1 });
    const [job] = await store.claimUpdates();
    await assert.rejects(store.handleUpdate(job, async ({ store: txnStore, leaveRepo }) => {
      await leaveRepo.updateLeaveRequestStatus('NP-TEST', { status: 'Từ chối', expectedVersion: '0', lockFinal: true }, 'Hà Nội');
      await txnStore.saveSession({ chatId: CHAT, userId: USER, requestId: 'NP-TEST', expectedVersion: '1' });
      throw new Error('crash before effects');
    }), /crash before effects/);
    assert.equal((await db.query('SELECT trang_thai FROM hr_leave_requests')).rows[0].trang_thai, 'Chưa duyệt');
    assert.equal((await db.query('SELECT count(*)::int AS total FROM hr_leave_change_events')).rows[0].total, 1);
    assert.equal(await store.getSession(CHAT), null);
    assert.equal((await db.query('SELECT handled_at FROM hr_manager_telegram_updates')).rows[0].handled_at, null);
    await db.exec("UPDATE hr_manager_telegram_updates SET lease_until = now() - interval '1 second'");
    const [newJob] = await store.claimUpdates();
    let called = false;
    await assert.rejects(store.handleUpdate(job, async () => { called = true; return []; }), err => err.code === 'TELEGRAM_LEASE_LOST');
    assert.equal(called, false);
    assert.notEqual(newJob.lease_token, job.lease_token);
  } finally { await db.close(); }
});

test('optimistic guard protects final decisions and detects stale non-final decisions', async () => {
  const { db, pool } = await fixture();
  try {
    const repo = createHrLeaveRepository({ pool });
    await assert.rejects(repo.updateLeaveRequestStatus('NP-TEST', { status: 'Tạm duyệt' }, 'Hà Nội'), err => err.code === 'INVALID_STATUS');
    await repo.updateLeaveRequestStatus('NP-TEST', { status: 'Chưa duyệt', note:'Updated pending note', expectedVersion: '0', lockFinal: true }, 'Hà Nội');
    await assert.rejects(repo.updateLeaveRequestStatus('NP-TEST', { status: 'Đã duyệt', expectedVersion: '0', lockFinal: true }, 'Hà Nội'), err => err.code === 'LEAVE_DECISION_CONFLICT');
    await repo.updateLeaveRequestStatus('NP-TEST', { status: 'Đã duyệt', expectedVersion: '1', lockFinal: true }, 'Hà Nội');
    await assert.rejects(repo.updateLeaveRequestStatus('NP-TEST', { status: 'Từ chối', expectedVersion: '2', lockFinal: true }, 'Hà Nội'), err => err.statusCode === 409);
    assert.equal((await repo.getLeaveRequestById('NP-TEST', 'Hà Nội')).decision_version, '2');
    await repo.updateLeaveRequestStatus('NP-TEST', { status: 'Từ chối' }, 'Hà Nội');
    assert.equal((await repo.getLeaveRequestById('NP-TEST', 'Hà Nội')).trang_thai, 'Từ chối', 'existing web edits remain possible');
  } finally { await db.close(); }
});

test('sessions require matching owner token and reject expired prompt attachments', async () => {
  const { db, store } = await fixture();
  try {
    const first = await store.saveSession({ chatId: CHAT, userId: USER, requestId: 'NP-TEST', expectedVersion: '9007199254740993' });
    assert.equal(first.expected_version, '9007199254740993');
    assert.equal(first.telegram_chat_id, CHAT);
    assert.match(first.session_id, /^[0-9a-f-]{36}$/);
    assert.ok(new Date(first.expires_at).getTime() - Date.now() > 14 * 60 * 1000);
    assert.equal(await store.setSessionPrompt(CHAT, first.session_id, '9007199254740994'), true);
    assert.equal((await store.getSession(CHAT)).prompt_message_id, '9007199254740994');
    const second = await store.saveSession({ chatId: CHAT, userId: USER, requestId: 'NP-TEST', expectedVersion: '0' });
    assert.notEqual(second.session_id, first.session_id);
    assert.equal(await store.deleteSession(CHAT, first.session_id), false);
    assert.equal(await store.setSessionPrompt(CHAT, first.session_id, '1'), false);
    await db.exec("UPDATE hr_manager_telegram_sessions SET expires_at = now() - interval '1 second'");
    assert.equal(await store.getSession(CHAT), null);
    assert.equal(await store.setSessionPrompt(CHAT, second.session_id, '1'), false);
    assert.equal(await store.deleteSession(CHAT, second.session_id), true);
  } finally { await db.close(); }
});

test('delivery retries, blocked chats, version refresh and ownership survive duplicate enqueue', async () => {
  const { db, store } = await fixture();
  try {
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '0' });
    let [job] = await store.claimDeliveries();
    assert.equal(job.sent_version, '-1');
    assert.equal(job.desired_version, '0');
    await store.retryDelivery(job, new Error('temporary'), 30);
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '1' });
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '0' });
    assert.equal((await store.getDelivery('NP-TEST', USER, CHAT)).desired_version, '1');
    assert.deepEqual(await store.claimDeliveries(), [], 'duplicate enqueue must retain retry delay');
    await db.exec("UPDATE hr_leave_manager_messages SET available_at = now() - interval '1 second'");
    const [next] = await store.claimDeliveries();
    assert.equal(await store.finishDelivery(job, { messageId: '999', version: '0' }), false);
    assert.equal(await store.retryDelivery(job, { statusCode: 403, message: 'stale forbidden' }), false);
    assert.equal(await store.finishDelivery(next, { messageId: '9007199254740995', version: '1' }), true);
    assert.equal((await store.getDelivery('NP-TEST', USER, CHAT)).message_id, '9007199254740995');
    assert.equal(await store.getDelivery('NP-TEST', USER, 'other-chat'), null);
    await store.queueExistingDeliveries('NP-TEST', '2');
    [job] = await store.claimDeliveries();
    const forbidden = new Error('Forbidden'); forbidden.statusCode = 403;
    await store.retryDelivery(job, forbidden);
    await store.queueExistingDeliveries('NP-TEST', '3');
    assert.deepEqual(await store.claimDeliveries(), [], 'version changes must preserve blocked state');
    assert.equal((await store.getDelivery('NP-TEST', USER, CHAT)).blocked, true);
    await store.wakeDeliveries(CHAT);
    [job] = await store.claimDeliveries();
    assert.equal(job.desired_version, '3');
    assert.equal(job.message_id, '9007199254740995');
    await store.retryDelivery(job, new Error('temporary'));
    const delayed = (await db.query("SELECT extract(epoch FROM available_at - now())::int AS wait FROM hr_leave_manager_messages")).rows[0].wait;
    assert.ok(delayed > 0 && delayed <= 3600);
    await db.exec("UPDATE hr_leave_manager_messages SET attempts = 30, available_at = now() - interval '1 second'");
    [job] = await store.claimDeliveries();
    await store.retryDelivery(job, new Error('repeated failure'));
    assert.equal((await db.query("SELECT extract(epoch FROM available_at - now())::int AS wait FROM hr_leave_manager_messages")).rows[0].wait, 3600);
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: 'previous-chat', version: '0' });
    await store.queueExistingDeliveries('NP-TEST', '4');
    assert.equal((await store.getDelivery('NP-TEST', USER, 'previous-chat')).desired_version, '4');
    assert.equal((await store.getDelivery('NP-TEST', USER, CHAT)).desired_version, '4');
  } finally { await db.close(); }
});

test('event jobs skip claimed work, retry durably and refuse stale completions', async () => {
  const { db, store } = await fixture();
  try {
    const [old] = await store.claimEvents();
    assert.equal(old.decision_version, '0');
    assert.deepEqual(await store.claimEvents(), []);
    await store.retryEvent(old, new Error('event failed'));
    assert.deepEqual(await store.claimEvents(), []);
    await db.exec("UPDATE hr_leave_change_events SET available_at = now() - interval '1 second'");
    const [current] = await store.claimEvents();
    assert.equal(current.attempts, 2);
    assert.equal(await store.completeEvent(old), false);
    assert.equal(await store.retryEvent(old, new Error('stale retry')), false);
    assert.equal(await store.completeEvent(current), true);
    assert.deepEqual(await store.claimEvents(), []);
  } finally { await db.close(); }
});

test('inbox preserves per-chat ordering across active leases and scheduled retries', async () => {
  const { db, store } = await fixture();
  try {
    await store.enqueueUpdate({ update_id: 1, message: { chat: { id: CHAT }, text: 'First' } });
    await store.enqueueUpdate({ update_id: 2, callback_query: { message: { chat: { id: CHAT } } } });
    await store.enqueueUpdate({ update_id: 3, message: { chat: { id: 'other-chat' } } });
    const jobs = await store.claimUpdates();
    assert.deepEqual(jobs.map(job => job.update_id).sort(), ['1', '3']);
    assert.deepEqual(await store.claimUpdates(), [], 'an active earlier update blocks later updates in its chat');
    const first = jobs.find(job => job.update_id === '1');
    await store.retryUpdate(first, new Error('retry first'), 30);
    assert.deepEqual(await store.claimUpdates(), [], 'a delayed earlier update still blocks later updates in its chat');
    await db.exec("UPDATE hr_manager_telegram_updates SET available_at = now() - interval '1 second' WHERE update_id = 1");
    const [retry] = await store.claimUpdates();
    assert.equal(retry.update_id, '1');
    await store.handleUpdate(retry, async () => []);
    assert.equal(await store.completeUpdate(retry), true);
    assert.deepEqual((await store.claimUpdates()).map(job => job.update_id), ['2']);
  } finally { await db.close(); }
});

test('waking a blocked card forces a refresh and preserves settled unblocked cards', async () => {
  const { db, store } = await fixture();
  try {
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '0' });
    const [blocked] = await store.claimDeliveries();
    await store.finishDelivery(blocked, { messageId: '42', version: '0', blocked: true });
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: 'unblocked-chat', version: '0' });
    const [settled] = await store.claimDeliveries();
    await store.finishDelivery(settled, { messageId: '43', version: '0' });
    assert.deepEqual(await store.claimDeliveries(), []);
    await store.wakeDeliveries(CHAT);
    await store.wakeDeliveries('unblocked-chat');
    const jobs = await store.claimDeliveries();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].telegram_chat_id, CHAT);
    assert.equal(jobs[0].message_id, '42');
    assert.equal(jobs[0].sent_version, '-1');
    assert.equal(jobs[0].desired_version, '0');
    assert.equal((await store.getDelivery('NP-TEST', USER, 'unblocked-chat')).sent_version, '0');
  } finally { await db.close(); }
});

test('activation records one persistent first-enabled timestamp across store instances', async () => {
  const { db, pool, store } = await fixture();
  try {
    const first = await store.activate?.();
    assert.ok(first instanceof Date, 'activate must return the persisted timestamp as a Date');
    const restartedStore = createManagerLeaveStore({ pool });
    const [again, concurrent] = await Promise.all([store.activate(), restartedStore.activate()]);
    assert.equal(again.getTime(), first.getTime());
    assert.equal(concurrent.getTime(), first.getTime());
    assert.equal((await db.query('SELECT count(*)::int AS total FROM hr_manager_telegram_state')).rows[0].total, 1);
    assert.equal((await db.query("SELECT has_table_privilege('reporting_readonly', 'hr_manager_telegram_state', 'SELECT') AS allowed")).rows[0].allowed, false);
  } finally { await db.close(); }
});

test('event creation uses wall-clock time even inside a transaction started before activation', async () => {
  const { db, store } = await fixture();
  try {
    await db.exec('BEGIN; SELECT pg_sleep(0.03)');
    const activated = await store.activate?.();
    await db.exec(`SELECT pg_sleep(0.03);
      INSERT INTO hr_leave_requests(request_id, branch, start_date, start_session,
        end_date, end_session, tong_buoi_nghi) VALUES ('NP-NEW', 'hanoi', '2026-10-02', 'Sáng', '2026-10-02', 'Chiều', 2);`);
    const event = (await db.query("SELECT created_at FROM hr_leave_change_events WHERE request_id = 'NP-NEW'")).rows[0];
    assert.ok(activated instanceof Date, 'activate must return the persisted timestamp as a Date');
    assert.ok(new Date(event.created_at).getTime() >= activated.getTime());
    await db.exec('COMMIT');
  } finally { await db.close(); }
});

test('list card message is persisted so its callbacks can use original-card validation',async()=>{const {db,store}=await fixture();try{await store.enqueueDelivery({requestId:'NP-TEST',userId:USER,chatId:CHAT,version:'0'});const [job]=await store.claimDeliveries();await store.finishDelivery(job,{messageId:'10',version:'0'});await store.recordDeliveryMessage({requestId:'NP-TEST',userId:USER,chatId:CHAT,version:'0',messageId:'55'});const delivery=await store.getDelivery('NP-TEST',USER,CHAT,'55');assert.equal(delivery.message_id,'55');assert.equal((await store.getDelivery('NP-TEST',USER,CHAT)).message_id,'10');}finally{await db.close();}});

test('enqueueDelivery cung hoac thap phien ban thi khong ghi lai dong', async () => {
  const { db, store } = await fixture();
  try {
    const xmin = async () => (await db.query('SELECT xmin::text AS x, desired_version::text AS v FROM hr_leave_manager_messages')).rows[0];
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '1' });
    const before = await xmin();
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '1' });
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '0' });
    assert.deepEqual(await xmin(), before, 'khong co phien ban dong moi');
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '2' });
    const after = await xmin();
    assert.notEqual(after.x, before.x);
    assert.equal(after.v, '2');
  } finally { await db.close(); }
});
