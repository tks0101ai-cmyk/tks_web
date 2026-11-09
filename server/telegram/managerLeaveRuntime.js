'use strict';

const CONFIG = require('../config');
const appUsers = require('../auth/appUsersRepository');
const { getPool } = require('../db/pool');
const leaveRepoDefault = require('../hr/hrLeaveRepository');
const { createHrLeaveDecisionService } = require('../hr/hrLeaveDecisionService');
const { BRANCHES } = require('../branch/branches');
const { createManagerLeaveStore } = require('./managerLeaveStore');
const { createManagerLeaveBot, isEligibleManager } = require('./managerLeaveBot');
const { buildManagerLeaveMessage } = require('./managerLeaveMessage');
const { createTelegramApi } = require('./telegramApi');

const { createHrLeaveAuthorization, isActiveApprover, selectApprovers } = require('../hr/hrLeaveAuthorization');
const BOTH_BRANCHES = [BRANCHES.HANOI, BRANCHES.SAIGON];

function validateManagerTelegramConfig(config) {
  if (!config.HR_MANAGER_TELEGRAM_ENABLED) return false;
  let url;
  try { url = new URL(config.HR_MANAGER_TELEGRAM_WEB_URL); } catch (_) { /* validated below */ }
  if (!config.HR_MANAGER_TELEGRAM_BOT_TOKEN || !/^[A-Za-z0-9_-]{1,256}$/.test(config.HR_MANAGER_TELEGRAM_WEBHOOK_SECRET || '') ||
      !url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Thiếu hoặc sai cấu hình bot Telegram quản lý: token, webhook secret, URL gốc HTTPS.');
  }
  return true;
}

async function resolveManagerFromDb(telegramId) {
  const { rows } = await getPool().query(`SELECT u.* FROM app_users u
    WHERE u.telegram_id = $1 AND NOT u.is_deleted`, [String(telegramId)]);
  if (!rows[0]) return null;
  // Quyền duyệt chỉ đọc app_users như web; HR nghỉ việc thì khóa tài khoản.
  // Never mutate accounts while authorizing a bot.
  const user = appUsers.rowToUser(rows[0]);
  return isEligibleManager(user, telegramId) ? user : null;
}

async function loadManagersFromDb({ selectAll = appUsers.selectAllRows, resolve = user => user, logger = console } = {}) {
  const candidates = await selectAll();
  const managers = [];
  for (const candidate of candidates) {
    try {
      const user = await resolve(candidate);
      if (isActiveApprover(user)) managers.push(user);
    } catch (err) {
      logger.error('[Telegram manager] Bỏ qua tài khoản chưa xác minh được quyền:', err.code || 'ACCOUNT_UNAVAILABLE');
    }
  }
  return managers;
}

function createManagerLeaveRuntime({
  store = createManagerLeaveStore(), leaveRepo = leaveRepoDefault,
  telegram, getManager = resolveManagerFromDb, loadManagers = loadManagersFromDb,
  botFactory = createManagerLeaveBot, buildMessage = buildManagerLeaveMessage,
  notifyDecision, authorization = createHrLeaveAuthorization({loadUsers:loadManagers}),
  webUrl = CONFIG.HR_MANAGER_TELEGRAM_WEB_URL, intervalMs = 5000, logger = console,
  managersTtlMs = 5 * 60 * 1000, now = Date.now,
  // Don moi da di qua hang su kien (claimEvents); quet lai don cho chi de bu quan ly moi gan Telegram.
  backlogIntervalMs = 10 * 60 * 1000
} = {}) {
  // Danh sách quản lý chỉ dùng để định tuyến thẻ mới; cache 5 phút và chỉ nạp khi có việc.
  // Quyền duyệt thật (authorization.canDecide) vẫn đọc tươi, không qua cache này.
  let managersCache = null, managersAt = 0, managersLoading = null;
  async function getCachedManagers() {
    if (managersCache && now() - managersAt < managersTtlMs) return managersCache;
    if (!managersLoading) managersLoading = Promise.resolve(loadManagers()).then(list => { managersCache = list; managersAt = now(); return list; }).finally(() => { managersLoading = null; });
    return managersLoading;
  }
  function invalidateManagers() { managersCache = null; managersAt = 0; }
  const lazyManagers = () => getCachedManagers();
  const decisionNotifications = createHrLeaveDecisionService({ logger, authorization });
  let timer;
  let inboxRunning = false, inboxRequested = false, deliveryRunning = false, deliveryRequested = false;
  let activation;
  let firstEnabledAt;

  function timing(stage, started, extra = {}) { if (logger.info) logger.info('[Telegram manager] timing', {stage,ms:Date.now()-started,...extra}); }
  async function callTelegram(method,params) {
    const started=Date.now();try{return await telegram.call(method,params);}finally{timing('telegram',started,{method});}
  }
  async function acknowledgeUpdate(update) {
    const query = update && update.callback_query; if(!query || !query.id) return;
    const started = Date.now();
    try { await callTelegram('answerCallbackQuery',{callback_query_id:query.id,text:'Đã nhận. Đang xử lý…'}); }
    catch(error) { if(logger.info)logger.info('[Telegram manager] ack unavailable',{code:error.code || 'TELEGRAM_UNAVAILABLE'}); }
    finally { timing('ack',started,{updateId:update.update_id}); }
  }
  async function executeEffect(effect) {
    const requestId = effect.delivery?.requestId;
    if (requestId && store.withRequestLock) return store.withRequestLock(requestId,async(scope)=>{
      if (!await (scope?.leaveRepo || leaveRepo).getLeaveRequestById(requestId,BOTH_BRANCHES)) return;
      return executeEffectUnlocked(effect,scope?.store);
    });
    return executeEffectUnlocked(effect);
  }
  async function executeEffectUnlocked(effect,lockedStore=store) {
    if (effect.method === 'notifyDecision') {
      await (notifyDecision || decisionNotifications.notifyDecision)(effect.request, effect.userId, effect.note);
      return;
    }
    if (!['sendMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'].includes(effect.method)) {
      throw new Error('Unsupported Telegram effect');
    }
    if (effect.session) {
      const session = await lockedStore.getSession(effect.session.chatId);
      if (!session || session.session_id !== effect.session.sessionId || new Date(session.expires_at).getTime() <= Date.now()) return;
    }
    try {
      const result = await callTelegram(effect.method, effect.params);
      if(effect.delivery && result && result.message_id) await lockedStore.recordDeliveryMessage({...effect.delivery,messageId:String(result.message_id)});
      if (effect.session && result && result.message_id) {
        await lockedStore.setSessionPrompt(effect.session.chatId, effect.session.sessionId, String(result.message_id));
      }
    } catch (err) {
      // A blocked private chat cannot receive effects. The committed decision
      // and its web notifications must still finish; /start can restore cards.
      if (err.code === 403) return;
      // Callback alerts expire quickly and must never stall durable decisions.
      if (effect.method === 'answerCallbackQuery' && err.code === 400) return;
      if (['editMessageReplyMarkup','editMessageText'].includes(effect.method) && (err.notModified || err.messageMissing)) return;
      throw err;
    }
  }

  async function processUpdate(job) {
    try {
      const started=Date.now();
      if(job.created_at)timing('queue',new Date(job.created_at).getTime(),{updateId:job.update_id});
      const effects = await store.handleUpdate(job, async ({ store: transactionStore, leaveRepo: transactionRepo }) => {
        const deferred = [];
        const decisions = createHrLeaveDecisionService({ repo: transactionRepo, logger, authorization });
        const bot = botFactory({ store: transactionStore, leaveRepo: transactionRepo, getManager, webUrl, authorization,
          decide: async input => {
            const updated = await decisions.decide(input, { notify: false, broadcast: false });
            deferred.push({ method: 'notifyDecision', request: updated, userId: input.user.id, note: updated.ghi_chu_duyet });
            return updated;
          }
        });
        return [...await bot.handleUpdate(job.payload), ...deferred];
      });
      timing('database',started,{updateId:job.update_id});
      deliveryRequested=true;
      if (!Array.isArray(effects)) return; // Lease was taken by a replacement process.
      for (let i = Number(job.effects_done || 0); i < effects.length; i++) {
        const effect=effects[i];
        // Callback acknowledgement already happened after durable enqueue.
        // Persisted completion/error messages survive callback expiry and retries.
        const chatId=job.payload?.callback_query?.message?.chat?.id;
        await executeEffect(effect.method==='answerCallbackQuery' && chatId != null ? {method:'sendMessage',params:{chat_id:chatId,text:effect.params.text}} : effect);
        if (await store.completeEffect(job, i + 1) === false) return;
      }
      await store.completeUpdate(job);
    } catch (err) {
      await store.retryUpdate(job, err, err.retryAfter);
      logger.error('[Telegram manager] Sẽ thử lại thao tác:', err.code || 'PROCESSING_FAILED');
    }
  }

  async function processDelivery(job) {
    if (store.withRequestLock) return store.withRequestLock(job.request_id,scope=>processDeliveryUnlocked(job,scope?.store,scope?.leaveRepo));
    return processDeliveryUnlocked(job);
  }
  async function processDeliveryUnlocked(job,lockedStore=store,lockedRepo=leaveRepo) {
    try {
      const user = await getManager(job.telegram_chat_id);
      const record = await lockedRepo.getLeaveRequestById(job.request_id, BOTH_BRANCHES);
      const authorized = user && String(user.id) === String(job.user_id) && record &&
        await authorization.canDecide(user,record) && record.loai_yeu_cau === 'Xin nghỉ phép';
      if (!authorized) {
        if (job.message_id) {
          try { await callTelegram('editMessageReplyMarkup', { chat_id: job.telegram_chat_id, message_id: job.message_id, reply_markup: { inline_keyboard: [] } }); }
          catch (err) { if (!err.notModified && !err.messageMissing && err.code !== 403) throw err; }
        }
        await lockedStore.finishDelivery(job, { messageId: job.message_id, version: job.desired_version, blocked: true });
        return;
      }
      const payload = { chat_id: job.telegram_chat_id, ...buildMessage(record, { webUrl }) };
      let messageId = job.message_id;
      if (messageId) {
        try { await callTelegram('editMessageText', { ...payload, message_id: messageId }); }
        catch (err) {
          if (err.messageMissing) messageId = null;
          else if (!err.notModified) throw err;
        }
      }
      if (!messageId) messageId = String((await callTelegram('sendMessage', payload)).message_id);
      await lockedStore.finishDelivery(job, { messageId, version: record.decision_version });
    } catch (err) {
      await lockedStore.retryDelivery(job, err, err.retryAfter);
      logger.error('[Telegram manager] Chưa gửi được thông báo:', err.code || 'DELIVERY_FAILED');
    }
  }

  async function seedBacklog(getManagers) {
    const pending=(await Promise.all(['Chưa duyệt','Vi phạm'].map(status=>leaveRepo.getLeaveRequests({status},BOTH_BRANCHES)))).flat();
    for (const record of pending) {
      if (record.loai_yeu_cau !== 'Xin nghỉ phép') continue;
      for (const user of selectApprovers(await getManagers(),record).users.filter(user=>isEligibleManager(user))) {
        await store.enqueueDelivery({ requestId: record.request_id, userId: user.id, chatId: user.telegramId, version: record.decision_version });
      }
    }
  }

  async function refreshCards(record,lockedStore=store) {
    for(const card of await lockedStore.listCards(record.request_id)) {
      const user=await getManager(card.telegram_chat_id);
      const authorized=user && String(user.id)===String(card.user_id) && record.loai_yeu_cau==='Xin nghỉ phép' && await authorization.canDecide(user,record);
      const params={chat_id:card.telegram_chat_id,message_id:card.message_id};
      try {
        await callTelegram(authorized ? 'editMessageText' : 'editMessageReplyMarkup',authorized ? {...params,...buildMessage(record,{webUrl})} : {...params,reply_markup:{inline_keyboard:[]}});
      } catch(error) {
        if(error.code===403 || error.messageMissing){await lockedStore.finishCard(card,record.decision_version,{remove:true});continue;}
        if(!error.notModified)throw error;
      }
      await lockedStore.finishCard(card,record.decision_version);
    }
  }
  async function processEvent(job, getManagers) {
    if (store.withRequestLock) return store.withRequestLock(job.request_id,scope=>processEventUnlocked(job,getManagers,scope?.store,scope?.leaveRepo));
    return processEventUnlocked(job,getManagers);
  }
  async function processEventUnlocked(job, getManagers,lockedStore=store,lockedRepo=leaveRepo) {
    try {
      const record = await lockedRepo.getLeaveRequestById(job.request_id, BOTH_BRANCHES);
      if (record) {
        await lockedStore.queueExistingDeliveries(record.request_id, record.decision_version);
        await refreshCards(record,lockedStore);
        const isNewRequest = job.event_type === 'CREATE' && new Date(job.created_at).getTime() >= new Date(firstEnabledAt).getTime();
        if (record.loai_yeu_cau === 'Xin nghỉ phép' && (isNewRequest || !['Đã duyệt', 'Từ chối'].includes(record.trang_thai))) {
          for (const user of selectApprovers(await getManagers(),record).users.filter(user=>isEligibleManager(user))) {
            await lockedStore.enqueueDelivery({ requestId: record.request_id, userId: user.id, chatId: user.telegramId, version: record.decision_version });
          }
        }
      }
      await lockedStore.completeEvent(job);
    } catch (err) { await lockedStore.retryEvent(job, err); }
  }

  async function activate() {
    if(!activation) activation=store.activate().then(value=>{firstEnabledAt=value;}).catch(error=>{activation=null;throw error;});
    await activation;
  }
  async function processCancellation(job) {
    try {
      const params = {chat_id:job.telegram_chat_id,text:job.text};
      if (job.kind === 'card') Object.assign(params,{message_id:job.message_id,reply_markup:{inline_keyboard:[]}});
      await callTelegram(job.kind === 'card' ? 'editMessageText' : 'sendMessage',params);
      await store.completeCancellation(job);
    } catch(error) {
      if (error.code === 403 || (job.kind === 'card' && (error.notModified || error.messageMissing))) await store.completeCancellation(job);
      else {
        await store.retryCancellation(job,error);
        logger.error('[Telegram manager] Chưa gửi được thông báo hủy:',error.code || 'CANCELLATION_DELIVERY_FAILED');
      }
    }
  }
  async function drainInbox() {
    if(inboxRunning){inboxRequested=true;return;} inboxRunning=true;
    try {await activate();do {inboxRequested=false;for(let i=0;i<20;i++){const [job]=await store.claimUpdates(1);if(!job)break;await processUpdate(job);}}while(inboxRequested);}
    catch(error){logger.error('[Telegram manager] Inbox tạm dừng:',error.code || 'DB_UNAVAILABLE');}
    finally {inboxRunning=false;}
  }
  let backlogAt = -Infinity;
  async function drainDeliveries() {
    if(deliveryRunning){deliveryRequested=true;return;} deliveryRunning=true;
    try {await activate();do {deliveryRequested=false;if(store.claimCancellations)for(const job of await store.claimCancellations())await processCancellation(job);if(now()-backlogAt>=backlogIntervalMs){await seedBacklog(lazyManagers);backlogAt=now();}await store.requeueStaleCards();for(const job of await store.claimEvents())await processEvent(job,lazyManagers);for(let i=0;i<20;i++){const [job]=await store.claimDeliveries(1);if(!job)break;await processDelivery(job);}}while(deliveryRequested);}
    catch(error){logger.error('[Telegram manager] Delivery tạm dừng:',error.code || 'DB_UNAVAILABLE');}
    finally {deliveryRunning=false;}
  }
  async function drain(){await Promise.all([drainInbox(),drainDeliveries()]);if(deliveryRequested)await drainDeliveries();}
  function start() {
    if (timer) return;
    void drain();
    timer = setInterval(drain, intervalMs);
    timer.unref();
  }
  function stop() { clearInterval(timer); timer = null; }
  return { telegram, store, invalidateManagers, start, stop, drain, drainInbox, acknowledgeUpdate, getManager, processUpdate, processDelivery, processCancellation };
}

function createConfiguredManagerLeaveRuntime({ logger = console } = {}) {
  try {
    if (!validateManagerTelegramConfig(CONFIG)) return null;
    return createManagerLeaveRuntime({ telegram: createTelegramApi({ token: CONFIG.HR_MANAGER_TELEGRAM_BOT_TOKEN }), intervalMs: CONFIG.HR_MANAGER_TELEGRAM_SCAN_INTERVAL_MS, logger });
  } catch (err) {
    logger.error('[Telegram manager]', err.message);
    return null;
  }
}

let configuredRuntime;
function getConfiguredManagerLeaveRuntime() {
  if (configuredRuntime === undefined) configuredRuntime = createConfiguredManagerLeaveRuntime();
  return configuredRuntime;
}

module.exports = { createManagerLeaveRuntime, createConfiguredManagerLeaveRuntime, getConfiguredManagerLeaveRuntime, validateManagerTelegramConfig, loadManagersFromDb };
