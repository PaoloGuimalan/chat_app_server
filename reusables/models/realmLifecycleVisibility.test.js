const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('an inactive conversation cannot be classified through its surviving Mongo record', async () => {
  const source = fs.readFileSync(require.resolve('../../routes/users/index'), 'utf8');
  const start = source.indexOf('const conversationTypeOf =');
  const end = source.indexOf('\n/**', start);
  let mongoReads = 0;
  const context = {
    assertMessagingTarget: async () => { throw new Error('This realm is unavailable.'); },
    pool: {}, Conversations: { findOne() { mongoReads++; return { lean: async () => ({ conversationType: 'group' }) }; } },
  };
  vm.runInNewContext(`${source.slice(start, end)}; this.classify = conversationTypeOf;`, context);
  await assert.rejects(context.classify('disabled-room'), /unavailable/);
  assert.equal(mongoReads, 0);
});

test('a late file message cannot save or emit success after its realm is disabled', async () => {
  const source = fs.readFileSync(require.resolve('../../routes/users/index'), 'utf8');
  const start = source.indexOf('const saveFileMessage =');
  const end = source.indexOf('const sendUploadedFiles =', start);
  let saves = 0;
  const completions = [];
  const context = {
    normalizeConversationType: value => value,
    UserMessage: class { async save() { saves++; } },
    withActiveRealmWrite: async () => { throw new Error('This realm is unavailable.'); },
    pool: { getPool() { return {}; } },
    queueMessageTagging() {},
    ChatHistory: { updateMany: async () => {} }, SaveConversation: async () => {},
    console: { log() {} },
  };
  vm.runInNewContext(`${source.slice(start, end)}; this.save = saveFileMessage;`, context);
  await context.save('actor', 'message', 'pending', 'disabled-realm', [], 'file', false, '', 'file', 'group', ok => completions.push(ok));
  assert.equal(saves, 0);
  assert.deepEqual(completions, [false]);
});
