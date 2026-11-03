import http from 'node:http';
const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
http.createServer((req, res) => {
  let body=''; req.on('data', d => body+=d); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(404); return res.end('{}'); }
    const j = JSON.parse(body); const msgs = j.messages||[];
    const hasTool = msgs.some(m => m.role==='tool');
    if(!globalThis.d){globalThis.d=1;for(const t of j.tools||[]) if(/search_tool|run_typescript/.test(t.function.name)) console.error('[schema]',JSON.stringify(t.function).slice(0,900))}
    console.error('[mock] tools offered:', (j.tools||[]).map(t=>t.function.name).join(','), '| hasToolResult:', hasTool);
    res.writeHead(200, {'content-type':'text/event-stream'});
    const base = {id:'c1', object:'chat.completion.chunk', created:1, model:j.model};
    const names=(j.tools||[]).map(t=>t.function.name); const mcp=names.find(n=>/echo/.test(n));
    if (!hasTool && mcp) { sse(res,{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_2',type:'function',function:{name:mcp,arguments:JSON.stringify({text:'ping'})}}]},finish_reason:null}]}); sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}); }
    else if (!hasTool) {
      sse(res,{...base,choices:[{index:0,delta:{role:'assistant',content:'Creating the file. '},finish_reason:null}]});
      sse(res,{...base,choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'hello.txt',content:'hi from mock\n'})}}]},finish_reason:null}]});
      sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
    } else {
      sse(res,{...base,choices:[{index:0,delta:{role:'assistant',content:'Done: wrote hello.txt'},finish_reason:null}]});
      sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}});
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8799, '127.0.0.1', () => console.error('[mock] up'));
