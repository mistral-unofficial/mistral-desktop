import { spawn } from 'node:child_process';
import readline from 'node:readline';
const [bin, cwd, home] = process.argv.slice(2);
const p = spawn(bin, [], { cwd, env: { ...process.env, VIBE_HOME: home, MOCK_KEY:'x' }, stdio: ['pipe','pipe','pipe'] });
p.stderr.on('data', d => { const s=String(d); if (!/^\s*(File|\^|~|\.\.\.)/m.test(s)) process.stderr.write('[stderr] ' + s.slice(0,400)); });
let id = 0; const pending = new Map();
const w = o => p.stdin.write(JSON.stringify({jsonrpc:'2.0', ...o})+'\n');
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); w({id:i, method, params}); });
readline.createInterface({input:p.stdout}).on('line', l => {
  const m = JSON.parse(l);
  if (m.method && m.id !== undefined) {           // agent -> client request
    console.log('[agent request]', m.method, JSON.stringify(m.params).slice(0,400));
    if (m.method === 'session/request_permission') {
      const opt = m.params.options.find(o => o.kind?.startsWith('allow')) ?? m.params.options[0];
      w({id:m.id, result:{outcome:{outcome:'selected', optionId:opt.optionId}}});
    } else if (m.method === 'fs/write_text_file') { w({id:m.id, result:{}}); }
    else w({id:m.id, error:{code:-32601, message:'unsupported'}});
  } else if (m.method) {                          // notification
    const u = m.params?.update;
    console.log('[update]', u?.sessionUpdate ?? m.method, JSON.stringify(u?.content ?? u?.title ?? u ?? '').slice(0,200));
  } else if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const out = (t, r) => console.log(`\n== ${t}\n` + JSON.stringify(r.result ?? r.error, null, 1).slice(0, 1500));
out('initialize', await send('initialize', { protocolVersion: 1, clientCapabilities: { fs:{readTextFile:true,writeTextFile:true}, terminal:true }, clientInfo:{name:'mistral-desktop-spike',version:'0'} }));
const s = await send('session/new', { cwd, mcpServers: [{ name:'demo', command:'node', args:[process.env.MCP_SCRIPT], env:[] }] });
out('session/new', s);
const sid = s.result?.sessionId; await new Promise(r=>setTimeout(r,6000));
if (sid) out('session/prompt', await send('session/prompt', { sessionId: sid, prompt:[{type:'text', text:'create hello.txt'}] }));
p.kill(); process.exit(0);
