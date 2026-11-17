const test=require('node:test');const assert=require('node:assert/strict');
const {authorizedActingStream}=require('./actingIdentity');
test('established streams block private frames after acting permission is revoked',async()=>{
 assert.equal(typeof authorizedActingStream,'function');let allowed=true,reads=0;const sent=[];let ended=0;
 const client={async query(sql){reads++;return {rows:sql.startsWith('SELECT name')?[{name:'Garden Club'}]:allowed?[{id:'r'}]:[]};}};
 const stream=authorizedActingStream({sse:(event,payload)=>sent.push({event,payload}),end:()=>ended++},'personal','page',client,'notifications');
 await stream.sse('post_activity',{secret:'before'});allowed=false;await stream.sse('incomingcall',{secret:'after'});await stream.sse('post_activity',{secret:'never'});
 assert.equal(sent.length,2);assert.equal(sent[1].event,'notifications');assert.equal(sent[1].payload.code,'REALM_ACCESS_REVOKED');assert.equal(sent[1].payload.message,'Your access to Garden Club was revoked.');assert.equal(JSON.stringify(sent).includes('after'),false);assert.equal(ended,1);
});
test('personal streams stay query-free and transient SQL failures are not revocations',async()=>{
 assert.equal(typeof authorizedActingStream,'function');const sent=[];const client={query:async()=>{throw new Error('offline');}};
 const personal=authorizedActingStream({sse:(event,payload)=>sent.push(payload)},'personal','personal',client);await personal.sse('notifications',{ok:true});assert.deepEqual(sent,[{ok:true}]);
 const acting=authorizedActingStream({sse:(event,payload)=>sent.push(payload)},'personal','page',client);await acting.sse('post_activity',{secret:'hidden'});assert.equal(sent.length,1);
});
