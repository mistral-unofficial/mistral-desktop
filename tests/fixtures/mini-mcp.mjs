import readline from 'node:readline';
const w = o => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\n');
readline.createInterface({input:process.stdin}).on('line', l => {
  const m = JSON.parse(l);
  if (m.method==='initialize') w({id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'mini',version:'1'}}});
  else if (m.method==='tools/list') w({id:m.id,result:{tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}});
  else if (m.method==='tools/call') w({id:m.id,result:{content:[{type:'text',text:'ECHO:'+m.params.arguments.text}]}});
  else if (m.id!==undefined) w({id:m.id,result:{}});
});
