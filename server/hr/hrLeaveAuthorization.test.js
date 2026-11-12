'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { normalizeDepartments, isActiveApprover, matchesApprovalScope, selectApprovers, createHrLeaveAuthorization }=require('./hrLeaveAuthorization');
const STAFF={id:'staff',username:'staff',vaiTro:'Nhân viên kho',trangThai:'Đang hoạt động',coSo:'Hà Nội',assignedCoSo:'Hà Nội',leaveApprovalDepartments:['Kho'],featurePermissions:{'hr.leave.manage':true}};
const REQUEST={request_id:'NP-1',co_so:'Hà Nội',bo_phan:' KHO ',user_id:'staff'};
test('staff grant approves own request only in explicit department and assigned branch',()=>{
 assert.equal(isActiveApprover(STAFF),true); assert.equal(matchesApprovalScope(STAFF,REQUEST),true);
 assert.equal(matchesApprovalScope(STAFF,{...REQUEST,bo_phan:'Kế toán'}),false);
 assert.equal(matchesApprovalScope({...STAFF,coSo:'Cả hai'}, {...REQUEST,co_so:'Sài Gòn'}),false);
 assert.equal(matchesApprovalScope({...STAFF,assignedCoSo:''},REQUEST),false);
 assert.deepEqual(normalizeDepartments([' Kho ','KHO','Kế  toán']),['Kho','Kế toán']);
});
test('recipient routing excludes inactive and revoked users and falls back only with no normal approver',()=>{
 const senior={...STAFF,id:'senior',username:'admin',leaveApprovalDepartments:[],assignedCoSo:''};
 assert.deepEqual(selectApprovers([STAFF,senior],REQUEST).users.map(u=>u.id),['staff']);
 const route=selectApprovers([{...STAFF,trangThai:'Khóa'},senior],REQUEST);
 assert.equal(route.fallback,true);assert.deepEqual(route.users.map(u=>u.id),['senior']);
 assert.equal(selectApprovers([{...senior,trangThai:'Khóa'}],REQUEST).missing,true);
 assert.equal(selectApprovers([{...STAFF,featurePermissions:{'hr.leave.manage':false}}],REQUEST).missing,true);
 assert.equal(selectApprovers([STAFF],{...REQUEST,bo_phan:''}).missing,true);
});
test('authorization reloads current account before every action and refuses revoked scope',async()=>{
 let current={...STAFF};const authorization=createHrLeaveAuthorization({loadUsers:async()=>[current]});
 assert.equal((await authorization.authorize(STAFF,REQUEST)).id,'staff');
 current={...STAFF,leaveApprovalDepartments:[]};
 await assert.rejects(authorization.authorize(STAFF,REQUEST),e=>e.statusCode===403);
 assert.equal(await authorization.canDecide(STAFF,REQUEST),false);
 current={...STAFF,username:'renamed',trangThai:'Khóa'};
 await assert.rejects(authorization.authorize(STAFF,REQUEST),e=>e.statusCode===403);
});
test('quyền duyệt chỉ theo trạng thái tài khoản, không đọc hồ sơ HR',()=>{
 assert.equal(isActiveApprover({...STAFF,hrEmployeeActive:false}),true);
 assert.equal(isActiveApprover({...STAFF,trangThai:'Khóa'}),false);
});

// 12/11/2026: danh sách nghỉ phép dùng bản tính sẵn (createApproverIndex) thay vì selectApprovers cho từng đơn × tài khoản.
test('approver index routes every request exactly like selectApprovers, including fallback and missing cases',()=>{
 const { createApproverIndex }=require('./hrLeaveAuthorization');
 const departments=['Kho',' KHO ','Kế toán','kế  toán','Sale','',null];
 const branches=['Hà Nội','Sài Gòn','Cả hai','',undefined];
 const statuses=['Đang hoạt động','Đã khóa'];
 const users=[];
 for(let i=0;i<60;i++) users.push({...STAFF,id:'u'+i,username:i%17===0?'admin':'u'+i,trangThai:statuses[i%7===0?1:0],isDeleted:i%11===0,
   coSo:branches[i%branches.length],assignedCoSo:i%4===0?undefined:branches[(i+1)%branches.length],
   leaveApprovalDepartments:i%9===0?undefined:[departments[i%departments.length],departments[(i*3)%departments.length]],
   featurePermissions:i%5===0?{}:STAFF.featurePermissions});
 const requests=[];
 for(let i=0;i<80;i++) requests.push({request_id:'NP-'+i,co_so:i%6===0?undefined:branches[i%branches.length],branch:['hanoi','saigon',''][i%3],bo_phan:departments[(i*5)%departments.length]});
 const routingOf=createApproverIndex(users);
 const ids=routing=>({ids:routing.users.map(u=>u.id),fallback:routing.fallback,missing:routing.missing});
 let fallbacks=0,normals=0;
 for(const request of requests){
  const expected=selectApprovers(users,request);
  assert.deepEqual(ids(routingOf(request)),ids(expected),request.request_id);
  if(expected.fallback) fallbacks++; else normals++;
 }
 assert.ok(fallbacks>0&&normals>0,'fixture covers both normal and fallback routing');
 const noSenior=createApproverIndex(users.filter(u=>u.username!=='admin'));
 assert.equal(noSenior({co_so:'Hà Nội',bo_phan:'Không có'}).missing,true);
});
