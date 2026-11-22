const { activeRealmSQL } = require('./realmAccess');

// Metadata only; filter Mongo before its unread/total/pagination stages so an
// inactive realm cannot leave a preview or consume a visible page slot.
async function blockedConversationIDs(client, candidates) {
  const relevant=candidates.filter(row=>!row.conversationType || !['single','user'].includes(row.conversationType));
  const ids=[...new Set(relevant.map(row=>String(row.conversationID)))];
  if(!ids.length)return [];
  const found=new Set(),blocked=new Set();
  for(let i=0;i<ids.length;i+=100){
    const {rows}=await client.query(`SELECT r.realm_id, ${activeRealmSQL('r')} AS available FROM community_realm r WHERE r.realm_id=ANY($1::text[])`,[ids.slice(i,i+100)]);
    for(const row of rows){const id=String(row.realm_id);found.add(id);if(row.available!==true)blocked.add(id);}
  }
  for(const row of relevant)if(row.conversationType && !found.has(String(row.conversationID)))blocked.add(String(row.conversationID));
  return [...blocked];
}
module.exports={blockedConversationIDs};
