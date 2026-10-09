import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const repo = new URL('..', import.meta.url).pathname;
const sdk = `
export async function discoverAndLoadExtensions(paths) {
 if (process.env.BAD_API === 'loader') return {errors:['factory incompatible'],extensions:[]};
 const handlers = new Map(), runtime = {};
 const pi = {on:(name,fn)=>handlers.set(name,fn),registerTool(){},setActiveTools:(...args)=>runtime.setActiveTools?.(...args)};
 if (process.env.BAD_API === 'setActiveTools') delete pi.setActiveTools;
 if (process.env.BAD_API === 'registerTool') delete pi.registerTool;
 if (paths[0].endsWith('probe.mjs')) {
  try {(await import('file://' + paths[0])).default(pi);} catch {return {errors:['API missing'],extensions:[]};}
 }
 return {errors:[],extensions:[{handlers,tools:new Map([['read',{}],['edit',{}]]),commands:new Map(),flags:new Map()}],runtime};
}
export class ExtensionRunner {
 constructor(ext,runtime,cwd,manager){this.handlers=ext[0].handlers;this.runtime=runtime;this.manager=manager;}
 bindCore(actions,context){Object.assign(this.runtime,actions);this.context=context;}
 async emit(event){await this.handlers.get(event.type)(event,{sessionManager:this.manager,ui:process.env.BAD_API==='context'?{}:{setWidget(){}}});}
}
`;
async function fixture(extra = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'forge-install-test-')));
  const home = join(root, 'home'), bin = join(root, 'bin'), agent = join(home, '.pi/agent');
  await mkdir(bin); await mkdir(join(agent, 'extensions/forge-for-pi'), {recursive:true});
  await mkdir(join(home, '.local/bin'), {recursive:true});
  await writeFile(join(agent, 'extensions/forge-for-pi/previous'), 'previous installation');
  for (const name of ['Forge','Forgetrace'])
    await writeFile(join(home, '.local/bin', name), '#!/bin/bash\n# Managed by Forge for Pi\necho previous\n', {mode:0o755});
  for (const name of ['ForgeJev','ForgeApis']) await writeFile(join(home, '.local/bin', name), name + ' sentinel');
  for (const name of ['auth.json','settings.json','models.json']) await writeFile(join(agent, name), 'private sentinel');
  await mkdir(join(agent,'forgejev/routing'),{recursive:true});
  await writeFile(join(agent,'forgejev/routing/ledger.json'),'ledger sentinel');
  await writeFile(join(home,'.bashrc'),'# user configuration\n');
  const node = execFileSync('which',['node'],{encoding:'utf8'}).trim();
  await symlink(realpathSync(node),join(bin,'node'));
  await writeFile(join(bin,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',type:'module',main:'sdk.mjs'}));
  await writeFile(join(bin,'sdk.mjs'),sdk);
  await writeFile(join(bin,'pi'),`#!/bin/bash
[ "$BROKEN_PI" = 1 ] && exit 7
case "$*" in
 *--version*) if [ "$FORGE_FOR_PI" = 1 ] && [ "$BAD_LAUNCHER" = 1 ]; then echo other; else printf '%s\\n' "$FAKE_PI_VERSION"; fi ;;
 *--help*) echo '--no-extensions --extension'; [ "$BAD_CLI" = 1 ] || echo '--no-skills' ;;
 *) exit 8 ;;
esac
`,{mode:0o755});
  const env = {HOME:home,PI_CODING_AGENT_DIR:agent,TMPDIR:root,PATH:`${bin}:/usr/bin:/bin`,SHELL:'/bin/bash',FAKE_PI_VERSION:'1.1.0',...extra};
  const run = script => spawnSync('/bin/bash',[join(repo,'scripts',script)],{env,encoding:'utf8'});
  return {root,home,agent,bin,env,run};
}
async function siblings(f) {
  for (const name of ['ForgeJev','ForgeApis']) assert.equal(await readFile(join(f.home,'.local/bin',name),'utf8'),name+' sentinel');
  for (const name of ['auth.json','settings.json','models.json']) assert.equal(await readFile(join(f.agent,name),'utf8'),'private sentinel');
  assert.equal(await readFile(join(f.agent,'forgejev/routing/ledger.json'),'utf8'),'ledger sentinel');
}
for (const version of ['1.0.4','1.1.0','9.0.0']) test(`compatible simulated Pi ${version}: install and verify`,async()=>{
  const f=await fixture({FAKE_PI_VERSION:version});
  const result=f.run('install.sh'); assert.equal(result.status,0,result.stderr);
  const verify=f.run('verify-install.sh'); assert.equal(verify.status,0,verify.stderr);
  assert.match(verify.stdout,new RegExp(version.replaceAll('.','\\.')));
  const dirs=await readdir(join(f.agent,'forge-for-pi-backups'));
  assert.ok(dirs.length);
  assert.equal(await readFile(join(f.agent,'forge-for-pi-backups',dirs[0],'previous-installation/previous'),'utf8'),'previous installation');
  await siblings(f);
});
for (const [name,extra] of [['broken CLI',{BROKEN_PI:'1'}],['empty version',{FAKE_PI_VERSION:''}],['missing flag',{BAD_CLI:'1'}],['missing setActiveTools',{BAD_API:'setActiveTools'}],['missing registerTool',{BAD_API:'registerTool'}],['factory incompatible',{BAD_API:'loader'}],['context incompatible',{BAD_API:'context'}]]) test(`reject ${name} before replacement`,async()=>{
  const f=await fixture(extra);assert.notEqual(f.run('install.sh').status,0);
  assert.equal(await readFile(join(f.agent,'extensions/forge-for-pi/previous'),'utf8'),'previous installation');await siblings(f);
});
test('missing Pi CLI',async()=>{
 const f=await fixture();f.env.PATH='/usr/bin:/bin';assert.notEqual(f.run('install.sh').status,0);
 assert.equal(await readFile(join(f.agent,'extensions/forge-for-pi/previous'),'utf8'),'previous installation');
});
for (const kind of ['launcher mismatch','copy failure']) test(`rollback after ${kind}`,async()=>{
 const f=await fixture(kind==='launcher mismatch'?{BAD_LAUNCHER:'1'}:{});
 if(kind==='copy failure')await writeFile(join(f.bin,'cp'),`#!/bin/bash\ncase "$*" in *src/forge-for-pi*) exit 8;; esac\nexec /bin/cp "$@"\n`,{mode:0o755});
 const result=f.run('install.sh');assert.notEqual(result.status,0);assert.match(result.stderr,/rollback checkpoint/);
 assert.equal(await readFile(join(f.agent,'extensions/forge-for-pi/previous'),'utf8'),'previous installation');
 for(const name of ['Forge','Forgetrace'])assert.match(await readFile(join(f.home,'.local/bin',name),'utf8'),/echo previous/);
 assert.equal(await readFile(join(f.home,'.bashrc'),'utf8'),'# user configuration\n');await siblings(f);
});
test('unmanaged launcher is not overwritten',async()=>{
 const f=await fixture();await writeFile(join(f.home,'.local/bin/Forge'),'unmanaged');
 assert.notEqual(f.run('install.sh').status,0);assert.equal(await readFile(join(f.home,'.local/bin/Forge'),'utf8'),'unmanaged');await siblings(f);
});
test('refuses to shadow another Forge executable on PATH',async()=>{
 const f=await fixture();await writeFile(join(f.bin,'Forge'),'#!/bin/sh\necho other\n',{mode:0o755});
 assert.notEqual(f.run('install.sh').status,0);
 assert.equal(await readFile(join(f.agent,'extensions/forge-for-pi/previous'),'utf8'),'previous installation');await siblings(f);
});
test('verifier rejects a newly incompatible API without mutating installation',async()=>{
 const f=await fixture();assert.equal(f.run('install.sh').status,0);
 const installed=await readFile(join(f.agent,'extensions/forge-for-pi/index.ts'),'utf8');
 f.env.BAD_API='setActiveTools';assert.notEqual(f.run('verify-install.sh').status,0);
 assert.equal(await readFile(join(f.agent,'extensions/forge-for-pi/index.ts'),'utf8'),installed);await siblings(f);
});
for(const kind of ['launcher','parent','descendant'])test(`reject ${kind} symlink`,async()=>{
 const f=await fixture();
 // Use a separate HOME for a symlinked launcher without deleting prior data.
 if(kind==='launcher') {f.env.HOME=join(f.root,'other-home');await mkdir(join(f.env.HOME,'.local/bin'),{recursive:true});await symlink(join(f.home,'.local/bin/Forge'),join(f.env.HOME,'.local/bin/Forge'));}
 if(kind==='parent'){f.env.PI_CODING_AGENT_DIR=join(f.root,'agent-link');await symlink(f.agent,f.env.PI_CODING_AGENT_DIR);}
 if(kind==='descendant')await symlink(join(f.root,'absent'),join(f.agent,'extensions/forge-for-pi/nested-link'));
 assert.notEqual(f.run('install.sh').status,0);await siblings(f);
});
