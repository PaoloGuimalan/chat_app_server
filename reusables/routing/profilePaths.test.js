const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('backend policy rejects reserved and malformed profile path claims', async () => {
  const { validateProfilePath } = require('./profilePaths');
  for (const value of ['studio', 'STUDIOS', ' scenes ', 'ｓｔｕｄｉｏ', 'login', 'api']) {
    await assert.rejects(async () => validateProfilePath(value, 'slug'), e => e.status === 400 && e.code === 'RESERVED_PATH');
  }
  for (const value of ['mystudio', 'studio-team', 'moderator', 'system']) await validateProfilePath(value, 'slug');
  for (const value of ['/studio', '%73tudio', 'name/path', 'name\\path', 'studi\to', 'studi\no', 'studi\ro', '.', '..']) await assert.rejects(async () => validateProfilePath(value, 'slug'));
});

function dynamicPolicy(state) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./profilePaths'), 'utf8'), {
    module, console, require: () => ({
      query: async () => { if (state.error) throw Error('offline'); return {rows: state.value === undefined ? [] : [{value:state.value}]}; },
    }),
  });
  return module.exports;
}

test('database variable edits apply to Node without restarting or merging removed defaults', async () => {
  const state = {value:{paths:[' ＬＡＵＮＣＨＰＡＤ ','studio']}}, policy = dynamicPolicy(state);
  await assert.rejects(async () => policy.validateProfilePath('launchpad'), e => e.code === 'RESERVED_PATH');
  state.value = {paths:['nextfeature']};
  await policy.validateProfilePath('launchpad'); await policy.validateProfilePath('studio');
  await assert.rejects(async () => policy.validateProfilePath('NEXTFEATURE'), e => e.code === 'RESERVED_PATH');
  state.value = {paths:[]}; await policy.validateProfilePath('nextfeature');
});

test('Node falls back safely for missing, malformed, or unreadable settings', async () => {
  for (const value of [undefined, {paths:'studio'}, {paths:['bad/path']}, {paths:[42]}]) {
    const policy=dynamicPolicy({value});
    await assert.rejects(async () => policy.validateProfilePath('studio'), e => e.code === 'RESERVED_PATH');
  }
  await assert.rejects(async () => dynamicPolicy({error:true}).validateProfilePath('studio'), e => e.code === 'RESERVED_PATH');
});

test('Unicode case variants use the same normalization as Django', async () => {
  const policy=dynamicPolicy({value:{paths:['Σ','STRAẞE']}});
  for(const value of ['σ','ς','straße','STRASSE']) await assert.rejects(async()=>policy.validateProfilePath(value),e=>e.code==='RESERVED_PATH');
});

test('page creation rejects a reserved slug before queries or image resolution', async () => {
  const { validateProfilePath } = require('./profilePaths');
  const source = fs.readFileSync(require.resolve('../../routes/users/index'), 'utf8');
  const start = source.indexOf('const createPage = async');
  const end = source.indexOf('// JSON: the page', start);
  let queries = 0, images = 0;
  const context = { validateProfilePath, pool: { query: async () => { queries++; return {rows:[]}; } },
    checkGroupID: async () => 'page', makeID: () => 'id', createRealmReusable: async () => {}, attachRecords: () => {} };
  vm.runInNewContext(source.slice(start, end) + '\nthis.createPage = createPage;', context);
  await assert.rejects(() => context.createPage({params:{entity_id:'entity'}}, {}, {slug:'studio'}, async () => { images++; }), e => e.code === 'RESERVED_PATH');
  assert.equal(queries, 0);
  assert.equal(images, 0);
});

test('public boot config returns the current Variable list for web feedback', async () => {
  const routes={}, state={value:{paths:['from-database']}}, policy=dynamicPolicy(state);
  const router={get:(route,handler)=>{routes[route]=handler;},post:()=>{},delete:()=>{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../routes/media/index'), 'utf8'), {
    module:{exports:{}},console, require:name=>name==='express'?{Router:()=>router}:name.endsWith('routing/profilePaths')?policy:name.endsWith('media/config')?{getMediaConfig:async()=>({limits:{},transfer:{}})}:{},
  });
  let body;const response={set:()=>{},send:value=>{body=value;}};
  await routes['/config']({},response);
  assert.deepEqual(Array.from(body.reserved_profile_paths),['from-database']);
  state.value={paths:[]};await routes['/config']({},response);
  assert.deepEqual(Array.from(body.reserved_profile_paths),[]);
});
