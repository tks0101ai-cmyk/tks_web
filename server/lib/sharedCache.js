'use strict';

// Cache only reconstructible source data. Stock, reservations and auth never use this module.
// Generation and value share a hash tag so the scripts also work with Redis Cluster.
const {randomUUID}=require('node:crypto');
const READ = "local g = redis.call('GET', KEYS[1]); if not g then g = ARGV[1]; redis.call('SET', KEYS[1], g) end; return {g, redis.call('GET', KEYS[2]) or ''}";
const WRITE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end return false";
const INVALIDATE = "redis.call('SET', KEYS[1], ARGV[1]); return redis.call('DEL', KEYS[2])";

function createSharedCache({client = null, getClient, namespace = 'tokosi:development:v1', timeoutMs = 150, now = Date.now} = {}) {
  const local = new Map(), pending = new Map(), generations = new Map();
  const stats = {hit:0, miss:0, error:0, bypass:0};
  const remoteConfigured = !!(client || getClient);
  const keys = key => {
    const tag = Buffer.from(String(key)).toString('base64url');
    return [`${namespace}:{${tag}}:generation`, `${namespace}:{${tag}}:value`];
  };
  async function command(fn) {
    let timer;
    try {
      const active = getClient ? getClient() : client;
      if (!active || !active.isReady) { stats.bypass++; return null; }
      return await Promise.race([
        Promise.resolve().then(() => fn(active)),
        new Promise((_, reject) => {timer = setTimeout(() => reject(Error('cache timeout')), timeoutMs);})
      ]);
    } catch (_) { stats.error++; return null; }
    finally { clearTimeout(timer); }
  }
  function decode(raw) {
    try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  async function get(key) {
    if (!remoteConfigured) {
      const entry = local.get(key);
      if (entry && entry.expires > now()) return entry.value;
      local.delete(key); return null;
    }
    return decode(await command(c => c.get(keys(key)[1])));
  }
  async function set(key, value, ttlMs) {
    if (!remoteConfigured) { local.set(key,{value,expires:now()+ttlMs}); return true; }
    return !!await command(c => c.set(keys(key)[1],JSON.stringify(value),{PX:ttlMs}));
  }
  async function invalidate(key) {
    generations.set(key,(generations.get(key)||0)+1);
    local.delete(key); pending.delete(key);
    if (remoteConfigured) await command(c => c.eval(INVALIDATE,{keys:keys(key),arguments:[randomUUID()]}));
  }
  function readThrough(key, ttlMs, load, {validate=()=>true} = {}) {
    if (pending.has(key)) return pending.get(key);
    const generation = generations.get(key)||0;
    const task = (async () => {
      let remote = null;
      if (remoteConfigured) {
        remote = await command(c => c.eval(READ,{keys:keys(key),arguments:[randomUUID()]}));
        const value = decode(remote && remote[1]);
        if (value && Number.isFinite(value.expires) && value.expires > now() && value.expires <= now()+ttlMs && Object.hasOwn(value,'data') && validate(value.data)) {stats.hit++; return value.data;}
      } else {
        const value = local.get(key);
        if (value && value.expires > now()) {stats.hit++; return value.value;}
      }
      stats.miss++;
      const value = await load();
      if (generation !== (generations.get(key)||0)) return value;
      if (!remoteConfigured) local.set(key,{value,expires:now()+ttlMs});
      else if (remote) {
        const envelope = JSON.stringify({data:value,expires:now()+ttlMs});
        await command(c => c.eval(WRITE,{keys:keys(key),arguments:[String(remote[0]),envelope,String(ttlMs)]}));
      }
      return value;
    })();
    pending.set(key,task);
    task.finally(()=>{if(pending.get(key)===task)pending.delete(key);}).catch(()=>{});
    return task;
  }
  return {get,set,invalidate,readThrough,stats};
}

let redisClient;
function getRedisClient() {
  if (!redisClient) {
    const {createClient} = require('redis');
    redisClient = createClient({url:process.env.REDIS_URL, disableOfflineQueue:true,
      commandsQueueMaxLength:100, commandOptions:{timeout:150},
      socket:{connectTimeout:1000,reconnectStrategy: retries => Math.min(1000 + retries * 500, 10000)}});
    // Errors may include connection URLs. Expose counters, never credentials or payloads.
    redisClient.on('error',()=>{});
    redisClient.connect().catch(()=>{});
    const stop = () => {if(redisClient?.isOpen)redisClient.destroy();};
    process.once('SIGTERM',stop); process.once('SIGINT',stop);
  }
  return redisClient;
}
const sharedCache = createSharedCache({
  namespace:process.env.REDIS_NAMESPACE || `tokosi:${process.env.NODE_ENV||'development'}:v1`,
  ...(process.env.REDIS_URL && process.env.REDIS_ENABLED !== 'false' ? {getClient:getRedisClient} : {})
});
module.exports = {createSharedCache,sharedCache};
