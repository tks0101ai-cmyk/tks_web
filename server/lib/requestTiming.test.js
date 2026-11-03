'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {startTiming, timedOperation} = require('./requestTiming');

test('timedOperation records async success and failure in Server-Timing', async()=>{
 const headers={};const res={headersSent:false,setHeader:(key,value)=>{headers[key]=value;},writeHead(){}};
 await new Promise((resolve,reject)=>startTiming({method:'GET',originalUrl:'/api/shipment/pick?order=PRIVATE'},res,()=>{
   (async()=>{
     assert.equal(await timedOperation('pickOrder',async()=>42),42);
     await assert.rejects(()=>timedOperation('pickLock',async()=>{throw new Error('failure');}),/failure/);
     res.writeHead(200);
     assert.match(headers['Server-Timing'],/pickOrder;dur=[\d.]+, pickLock;dur=[\d.]+, total;dur=[\d.]+/);
     assert.doesNotMatch(headers['Server-Timing'],/PRIVATE/);
   })().then(resolve,reject);
 }));
});
