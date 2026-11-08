'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../../public');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
const tick = async () => { for(let i=0;i<5;i++) await new Promise(setImmediate); };
test('audit sends sort layers and ignores stale success/error during debounce', async () => {
 const html = fs.readFileSync(path.join(root,'account/index.html'),'utf8');
 const calls=[], pending=[], nodes = Object.fromEntries(['historySearchInput','historyActionFilter','historyFromDate','historyToDate','historyTableBody','historyPagerInfo','historyPrevBtn','historyNextBtn'].map(k=>[k,{ value:'', innerHTML:'' }]));
 const context=vm.createContext({ URLSearchParams, console, setTimeout, clearTimeout, document:{getElementById:k=>nodes[k]}, fetch:url=>{calls.push(url); const d=deferred(); pending.push(d); return d.promise;}, historyPage:2,HISTORY_PAGE_SIZE:50,historyRequestSeq:0,historySorts:[{key:'actor',dir:'asc'}],historyReloadTimer:null,renderAuditHistory:data=>{context.rendered=data;} });
 const start=html.indexOf('    function loadAuditHistory()');
 vm.runInContext(html.slice(start, html.indexOf('    function renderKPIs',start)),context);
 vm.runInContext('loadAuditHistory()',context);
 assert.deepEqual(JSON.parse(new URL(calls[0],'https://tks').searchParams.get('sorts')),[{key:'actor',dir:'asc'}]);
 const schedule=html.slice(html.indexOf('    function scheduleHistoryReload()'),html.indexOf('    function reloadAuditHistory()'));
 vm.runInContext(schedule,context); context.reloadAuditHistory=()=>{};
 vm.runInContext('scheduleHistoryReload()',context);
 pending[0].resolve({ok:true,json:async()=>({old:true})}); await tick(); assert.equal(context.rendered,undefined);
 vm.runInContext('loadAuditHistory(); scheduleHistoryReload()',context);
 pending[1].reject(new Error('old failure')); await tick(); assert.equal(nodes.historyTableBody.innerHTML,'');
 clearTimeout(context.historyReloadTimer);
});
test('lifecycle history passes query/page/sorts and suppresses stale responses', async () => {
 const html=fs.readFileSync(path.join(root,'shipment/lifecycle/index.html'),'utf8');
 const calls=[], pending=[], node={textContent:'',hidden:true};
 const context=vm.createContext({URLSearchParams,console,document:{getElementById:()=>node},historySearchInput:{value:'An'},historyActiveBranchFilter:'HN',historyActiveStatusFilter:'SIGNED',historySorts:[{key:'orderCode',dir:'asc'}],historyPage:2,historyPageSize:100,historyTotalRows:0,historyRequestSeq:0,historyLoaded:false,allHistoryRows:[],historyCount:node,historyEmpty:node,TKSNav:{handleBranchError:()=>false},renderHistoryRows:rows=>{context.rendered=rows;},fetch:url=>{calls.push(url);const d=deferred();pending.push(d);return d.promise;} });
 const start=html.indexOf('    let historyLoadInFlight');
 vm.runInContext(html.slice(start,html.indexOf('    // Bo loc dang dropdown',start)),context);
 vm.runInContext('loadHistory(false); historyPage=3; loadHistory(false)',context);
 assert.equal(calls.length,2);
 const params=new URL(calls[1],'https://tks').searchParams;
 assert.equal(params.get('page'),'3');assert.equal(params.get('q'),'An');assert.equal(params.get('branch'),'HN');
 pending[1].resolve({ok:true,json:async()=>({rows:[{orderCode:'new'}],totalRows:205,page:3,pageSize:100})});await tick();
 pending[0].reject(new Error('old'));await tick();assert.equal(context.rendered[0].orderCode,'new');
});
