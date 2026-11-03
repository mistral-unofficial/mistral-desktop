import { spawn } from 'node:child_process';
import readline from 'node:readline';
const [bin, cwd, home] = process.argv.slice(2);
const p = spawn(bin, [], { cwd, env: { ...process.env, VIBE_HOME: home }, stdio: ['pipe','pipe','pipe'] });
p.stderr.on('data', d => process.stderr.write('[stderr] ' + d));
let id = 0; const pending = new Map();
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); p.stdin.write(JSON.stringify({jsonrpc:'2.0', id:i, method, params})+'\n'); });
readline.createInterface({input:p.stdout}).on('line', l => {
  const m = JSON.parse(l);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else console.log('[notif/req]', JSON.stringify(m).slice(0,300));
});
const show = (t, r) => console.log(`\n== ${t}\n` + JSON.stringify(r.result ?? r.error, null, 1).slice(0, 1800));
show('initialize', await send('initialize', { protocolVersion: 1, clientCapabilities: { fs:{readTextFile:true,writeTextFile:true}, terminal:true }, clientInfo:{name:'mistral-desktop-spike',version:'0'} }));
show('session/new (with stdio MCP server)', await send('session/new', { cwd, mcpServers: [{ name:'demo', command:'node', args:['-e','setInterval(()=>{},1e6)'], env:[] }] }));
p.kill();
