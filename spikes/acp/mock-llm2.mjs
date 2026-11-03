import http from 'node:http';
const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
let step = 0;
http.createServer((req, res) => {
  let body=''; req.on('data', d => body+=d); req.on('end', () => {
    const j = JSON.parse(body); if (!(j.tools||[]).length) { res.writeHead(200,{'content-type':'text/event-stream'}); sse(res,{id:'t',object:'chat.completion.chunk',created:1,model:'m',choices:[{index:0,delta:{role:'assistant',content:'title'},finish_reason:'stop'}]}); return res.end('data: [DONE]\n\n'); }
    const tools = (j.messages||[]).filter(m=>m.role==='tool'); 
    if (tools.length) console.error('[tool result #'+tools.length+']', String(tools.at(-1).content).slice(0,700));
    res.writeHead(200, {'content-type':'text/event-stream'});
    const base = {id:'c', object:'chat.completion.chunk', created:1, model:j.model};
    const call = (name,args) => { sse(res,{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'c'+tools.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]}); sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}); };
    if (tools.length===0) call('search_tool_functions',{mode:'best_match',query:'echo text'});
    else if (tools.length===1) { const m = String(tools[0].content).match(/[\w.]*echo[\w.]*/i); console.error('[found name]', m?.[0]); call('search_tool_functions',{mode:'details',name:m?.[0]}); }
    else { sse(res,{...base,choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]}); sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}); }
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8799,'127.0.0.1');
