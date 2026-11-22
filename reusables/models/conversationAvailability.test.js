const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
test('inactive and deleted realm conversations are excluded before paging; direct conversations remain',async()=>{
 assert.ok(fs.existsSync(__dirname+'/conversationAvailability.js'));
 const {blockedConversationIDs}=require('./conversationAvailability');let reads=0;
 const ids=await blockedConversationIDs({query:async(sql,args)=>{reads++;assert.deepEqual(args[0],['active','inactive','deleted']);return{rows:[{realm_id:'active',available:true}]};}},[
  {conversationID:'dm',conversationType:'single'},{conversationID:'active',conversationType:'group'},
  {conversationID:'inactive',conversationType:'voice'},{conversationID:'deleted',conversationType:'group'}]);
 assert.deepEqual(ids,['inactive','deleted']);assert.equal(reads,1);
 assert.deepEqual(await blockedConversationIDs({query:async()=>({rows:[{realm_id:'archived-without-participants',available:false}]})},[{conversationID:'archived-without-participants'}]),['archived-without-participants']);
 const route=fs.readFileSync(__dirname+'/../../routes/messages/index.js','utf8');
 for(const name of ['archives','conversations']){
  const start=route.indexOf(`router.get("/${name}"`),part=route.slice(start,route.indexOf('\nrouter.',start+1));
  assert.match(part,/blockedConversationIDs/);assert.ok(part.indexOf('blockedConversationIDs')<part.indexOf('$facet'));
 }
});
