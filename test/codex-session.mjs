// Opt-in real AI-client check. Uses only random synthetic data; never logs an unlock secret.
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { VaultSession } from '../dist/vault.js';
import { startBroker } from '../dist/broker.js';
import { proposal, approve } from './helpers.mjs';

const directory=await mkdtemp(join(tmpdir(),'gb-real-client-'));
const outputDirectory=process.env.GROWTH_BRAIN_TEST_OUTPUT ?? directory;
await mkdir(outputDirectory,{recursive:true,mode:0o700});
const vault=await VaultSession.open(join(directory,'vault'),randomUUID(),randomBytes(32).toString('base64url'),true);
const project=await vault.mutate(e=>e.addProject('Synthetic marketing session'));
const brand=`달빛공방-${randomBytes(4).toString('hex')}`;
await vault.mutate(e=>{
  approve(e,proposal({type:'global'},'language','한국어'));
  approve(e,proposal({type:'global'},'tone','반말로 친근하게'));
  approve(e,proposal({type:'project',projectId:project.id},'tone','존댓말로 과장 없이 전문적으로'));
  approve(e,proposal({type:'project',projectId:project.id},'brand',brand));
  const old=approve(e,proposal({type:'project',projectId:project.id},'cta','당장 구매하세요'));
  approve(e,proposal({type:'project',projectId:project.id},'cta','무료 상담을 신청하세요',{supersedesId:old}));
});
const broker=await startBroker(vault,join(directory,'vault'));
try {
 const working=join(directory,'work');const skill=join(working,'.agents','skills','growth-brain');
 await mkdir(skill,{recursive:true});
 await copyFile(resolve('integrations/codex/growth-brain/SKILL.md'),join(skill,'SKILL.md'));
 const prompt=`지난번 정한 조건대로 다음 콘텐츠를 진행해줘. 광고 초안을 세 문장으로 작성해줘. Growth Brain 프로젝트 ID: ${project.id}. 파일을 변경하지 말고 최종 답변으로 결과물을 보여줘.`;
 const output=join(outputDirectory,'codex-final.txt');
 const args=['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','-C',working,
  '-c',`mcp_servers.growth_brain.command=${JSON.stringify(process.execPath)}`,
  '-c',`mcp_servers.growth_brain.args=${JSON.stringify([resolve('dist/mcp.js')])}`,
  '-c',`mcp_servers.growth_brain.env.GROWTH_BRAIN_SOCKET=${JSON.stringify(broker.path)}`,
  '-o',output,prompt];
 const env={...process.env};delete env.IGN8T_API_KEY;
 const child=spawn('codex',args,{env,stdio:['ignore','pipe','pipe']});
 let events='',errors='';child.stdout.on('data',c=>events+=c);child.stderr.on('data',c=>errors+=c);
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},180000);
 const code=await new Promise((resolveCode,reject)=>{child.once('error',reject);child.once('close',resolveCode)});
 clearTimeout(timer);
 await writeFile(join(outputDirectory,'codex-events.jsonl'),events,{mode:0o600});
 await writeFile(join(outputDirectory,'codex-stderr.txt'),errors,{mode:0o600});
 const final=await readFile(output,'utf8').catch(()=>'');
 const parsed=events.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
 const calls=parsed.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call'&&e.item?.tool==='get_context');
 const success=code===0&&calls.some(e=>!e.item.error&&e.item.status==='completed')&&final.includes(brand)&&final.includes('무료 상담')&&!final.includes('당장 구매');
 const summary={kind:'actual Codex CLI session with synthetic data',code,timedOut,contextCalls:calls.length,brandApplied:final.includes(brand),latestCtaApplied:final.includes('무료 상담'),obsoleteCtaAbsent:!final.includes('당장 구매'),success,outputDirectory};
 await writeFile(join(outputDirectory,'codex-summary.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary));
 if(!success)process.exitCode=1;
} finally {await broker.close();await vault.close();await rm(directory,{recursive:true,force:true});}
