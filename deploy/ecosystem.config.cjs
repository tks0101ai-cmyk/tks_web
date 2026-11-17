// PM2 cho TOKOSI dashboard tren VPS. .env duoc nap boi run.cjs (xem file do).
// Web chay cluster voi DUNG 1 instance: `pm2 reload` bat ban moi truoc, tat ban cu sau => khong gian doan.
// KHONG tang instances > 1: web con chay job thong bao/Telegram trong tien trinh, se chay trung.
const path = require('path');

const APP_DIR = process.env.TOKOSI_APP_DIR || '/root/tokosi_dashboard/server';
const NODE = process.env.TOKOSI_NODE || '/opt/node24/bin/node';
const RUN = path.join(__dirname, 'run.cjs');

const base = {
  cwd: APP_DIR,
  script: RUN,
  interpreter: NODE,
  node_args: '--max-old-space-size=1024',
  max_memory_restart: '1200M',
  kill_timeout: 5000,
  env: { NODE_ENV: 'production', BACKGROUND_JOBS: 'worker', PORT: '3100', TOKOSI_APP_DIR: APP_DIR },
};

module.exports = {
  apps: [
    { ...base, name: 'tokosi-dash-web', exec_mode: 'cluster', instances: 1, listen_timeout: 30000, env: { ...base.env, TOKOSI_ENTRY: 'index.js' } },
    { ...base, name: 'tokosi-dash-worker', env: { ...base.env, TOKOSI_ENTRY: 'worker.js' } },
  ],
};
