// Test-only child for an isolated copy of the native UI. No external identity,
// credentials, remote service or encrypted vault is used in this presentation test.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const dir = path.join(__dirname, '..');
const trust = path.join(dir, 'synthetic-trust');
const trace = path.join(dir, 'test-operations.txt');
const projectId = '8f17a7af-c68f-4ff8-a883-4c139a5db814';
const email = 'win-ui@example.invalid';
let signed = false;
let route = 'off';
fs.writeFileSync(path.join(dir, 'child.pid'), String(process.pid));
function state() {
  return {exists:false, unlocked:signed, account:{configured:true,signedIn:signed,email:signed?email:null,sync:signed?'synced':'off',trusted:fs.existsSync(trust)},
    projects:signed?[{id:projectId,name:'Fresh PC'}]:[], web:{state:route,requests:[],connections:[],audit:[]}};
}
(async () => {
  for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
    const q=JSON.parse(line); let preview;
    fs.appendFileSync(trace, q.op+'\n');
    switch(q.op) {
    case 'accountResume':signed=fs.existsSync(trust);break;
    case 'status':break;
    case 'accountLogin':
      if(q.email!==email || !q.password)throw Error('bad test login');
      signed=true;if(q.trustDevice)fs.writeFileSync(trust,'synthetic');break;
    case 'previewContext':
      if(!signed)throw Error('not signed in');
      preview={conditions:[{key:'format',value:q.projectId===projectId?'PROJECT-FORMAT':'COMMON-FORMAT'}],handoff:null};break;
    case 'accountLogout':case 'lock':
      fs.rmSync(trust,{force:true});signed=false;break;
    case 'startWeb':route='unavailable';break;
    case 'accountSync':
      // Simulate a stalled network call. Windows session lock must still tear
      // this process down while the normal request channel is occupied.
      await new Promise(resolve=>setTimeout(resolve,90000));break;
    default:throw Error('Unexpected test operation');
    }
    process.stdout.write(JSON.stringify({id:q.id,ok:true,result:state(),preview})+'\n');
  }
})();
