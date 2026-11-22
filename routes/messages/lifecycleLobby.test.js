const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
test('conference lobby preserves lifecycle denial while retaining ordinary nonmember lobby',async()=>{
 let source=fs.readFileSync(__dirname+'/index.js','utf8');
 if(process.env.LIFECYCLE_PRE_FIX==='1')source=source.replace("!isConferenceRealm || err.code === 'REALM_UNAVAILABLE'","!isConferenceRealm");
 const start=source.indexOf('const isConferenceRealm = realmRows[0].type'),end=source.indexOf('if (!isMember)',start);
 async function run(error){return vm.runInNewContext(`(async()=>{${source.slice(start,end)}return isMember;})()`,{realmRows:[{type:'conference'}],resolvedConversationID:'room',entity_id:'viewer',isRealmMember:async()=>{throw error;}});}
 await assert.rejects(run(Object.assign(new Error('Unavailable'),{code:'REALM_UNAVAILABLE'})),/Unavailable/);
 assert.equal(await run(new Error('Not a member')),false);
});
