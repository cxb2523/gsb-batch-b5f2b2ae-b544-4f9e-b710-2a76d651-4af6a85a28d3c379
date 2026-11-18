import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,rm,readdir,writeFile,mkdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const ids=Array.from({length:8},(_,i)=>String(7695386527160863700n+BigInt(i)));
const tick=(ms=10)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,message='timed out waiting'){for(let i=0;i<300;i++){if(check())return;await tick()}assert.fail(message)}
const series=(id:string)=>({id,title:'迁移作品'+id,cover:'',description:'',total:2,episodes:[{id:id+'01',order:1},{id:id+'02',order:2}]});

test('迁移取消在途下载与转码并等待写盘清理完成，期间拒绝新下载删除和画质切换',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'manju-migrate-'));
 const target=await mkdtemp(path.join(tmpdir(),'manju-migrate-target-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>rm(target,{recursive:true,force:true}));
 const aborted:string[]=[],killed:number[]=[];let encodes=0,resourceFrozen=false;
 const spawnMock=t.mock.method(childProcess,'spawn',(_exe:string,args:readonly string[])=>{
  encodes++;const n=encodes;
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{killed.push(n);queueMicrotask(()=>child.emit('close',null));return true}});
  // The second encode (ids[2]) holds until it is killed; the rest complete.
  if(n!==2)queueMicrotask(async()=>{await writeFile(args.at(-1)!,'prepared-video');child.stdout.write('out_time_us=1000000\n');child.emit('close',0)});
  return child;
 });
 const fetchMock=t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{
  const id=new URL(url).pathname.slice(1);
  if(id===ids[1])return new Response(new ReadableStream<Uint8Array>({start(controller){
   controller.enqueue(Buffer.alloc(100));
   // The download handle stays open briefly after cancellation, like a real socket.
   init?.signal?.addEventListener('abort',()=>{aborted.push(id);setTimeout(()=>controller.error(Error('aborted')),40)},{once:true});
  }}),{headers:{'content-length':'1000','etag':'"stable"'}});
  return new Response(Buffer.from('source'));
 });
 syncBuiltinESMExports();
 const {MediaCache}=await import('../src/main/media');
 const media=new MediaCache(dir,'fake-ffmpeg',async id=>{
  if(resourceFrozen)throw Error('resource frozen');
  return {episodeId:id,duration:1,definition:'540p',codec:'h264',encrypted:false,url:`https://example.com/${id}`,size:id===ids[1]?1000:6};
 },{freeBytes:async()=>10*1024**3,concurrency:2,progressive:false});
 await media.init();
 t.after(async()=>{await media.close();spawnMock.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports()});
 const playback=await media.prepare(ids[0]);
 media.setBackgroundGroups([{id:ids[7],ids:[ids[1],ids[2]],paused:false}]);
 await until(()=>encodes===2&&media.usedBytes>0,'background download and transcode must be in flight');
 // ids[1] is mid-download with a partial on disk; ids[2] is mid-transcode (held).
 resourceFrozen=true;
 let committed=false,moved=false;
 const next=path.join(target,'HongguoManjuCache');
 const relocating=media.relocate(next,async()=>{committed=true}).then(()=>{moved=true});
 await assert.rejects(media.prepare(ids[3]),{code:'CACHE_MOVING'});
 assert.throws(()=>media.setQuality('720p'),{code:'CACHE_MOVING'});
 await assert.rejects(media.deleteEpisodes([ids[0]]),{code:'CACHE_BUSY'});
 assert.throws(()=>media.retryBuffer(),{code:'CACHE_MOVING'});
 assert.equal(moved,false,'迁移必须等待在途下载写盘与转码退出后才开始复制');
 await relocating;
 assert.ok(moved&&committed);
 assert.ok(aborted.includes(ids[1]));assert.equal(killed.length,1);
 assert.equal(media.location,next);
 const targetFiles=await readdir(next);
 assert.equal(targetFiles.filter(name=>name.endsWith('.working.mp4')).length,0,'临时转码文件不得进入新目录');
 assert.ok(targetFiles.some(name=>name.endsWith('.partial.mp4')),'断点分片必须随迁移复制');
 assert.ok(targetFiles.some(name=>name.endsWith('.partial.json')),'断点检查点必须随迁移复制');
 const key=new URL(playback.url).pathname.slice(1);
 assert.ok(targetFiles.includes(key+'.mp4'));assert.ok(targetFiles.includes(key+'.json'));
 assert.ok((await readdir(dir)).includes(key+'.mp4'),'原目录文件保留');
 assert.equal((await media.response(playback.url,null)).status,200);
 // 迁移后新的下载写入新目录
 resourceFrozen=false;
 const again=await media.prepare(ids[3]);
 assert.ok((await readdir(next)).includes(new URL(again.url).pathname.slice(1)+'.mp4'));
});

test('复制阶段原目录出现新分片或检查点时迁移失败并回滚，原目录与播放保持可用',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'manju-migrate-race-'));
 const target=await mkdtemp(path.join(tmpdir(),'manju-migrate-race-target-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>rm(target,{recursive:true,force:true}));
 const spawnMock=t.mock.method(childProcess,'spawn',(_exe:string,args:readonly string[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit('close',null));return true}});
  queueMicrotask(async()=>{await writeFile(args.at(-1)!,'prepared-video');child.stdout.write('out_time_us=1000000\n');child.emit('close',0)});
  return child;
 });
 const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response(Buffer.from('source')));
 syncBuiltinESMExports();
 const {MediaCache}=await import('../src/main/media');
 const media=new MediaCache(dir,'fake-ffmpeg',async id=>({episodeId:id,duration:1,definition:'540p',codec:'h264',encrypted:false,url:`https://example.com/${id}`,size:6}),{freeBytes:async()=>10*1024**3,concurrency:2});
 await media.init();
 t.after(async()=>{await media.close();spawnMock.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports()});
 const playback=await media.prepare(ids[0]);
 // A late resumable-download write lands in the source while the copy runs.
 const original=fsPromises.copyFile;let injected=false;
 const copyMock=t.mock.method(fsPromises,'copyFile',async(source:any,destination:any,mode?:any)=>{
  if(!injected){injected=true;await writeFile(path.join(dir,'1'.repeat(32)+'.partial.mp4'),'late-chunk');await writeFile(path.join(dir,'1'.repeat(32)+'.partial.json'),'{}')}
  return original(source,destination,mode);
 });
 syncBuiltinESMExports();
 const next=path.join(target,'HongguoManjuCache');let committed=false;
 await assert.rejects(media.relocate(next,async()=>{committed=true}),{code:'CACHE_VERIFY'});
 assert.equal(committed,false,'出现新分片时不得提交设置');
 assert.equal(media.location,dir,'目录设置必须保持指向原目录');
 assert.equal((await readdir(next)).length,0,'已复制文件必须回滚清理');
 assert.equal((await media.response(playback.url,null)).status,200,'原缓存播放保持可用');
 assert.equal(media.stateFor([ids[0]]).ready,1);
 // 原目录仍可继续缓存与下载
 const again=await media.prepare(ids[1]);
 assert.equal((await media.response(again.url,null)).status,200);
 copyMock.mock.restore();
});

test('迁移后断点续传与删除都指向新目录，原目录不再被写入',async t=>{
 const parent=await mkdtemp(path.join(tmpdir(),'manju-migrate-resume-'));
 t.after(()=>rm(parent,{recursive:true,force:true}));
 const old=path.join(parent,'old'),next=path.join(parent,'HongguoManjuCache');
 const bytes=Buffer.alloc(240000,1),requests:string[]=[];
 const server=createServer((req,res)=>{
  requests.push(req.headers.range||'full');
  const start=Number(req.headers.range?.match(/\d+/)?.[0]||0);
  res.writeHead(start?206:200,{'content-length':bytes.length-start,etag:'"one"',...(start?{'content-range':`bytes ${start}-${bytes.length-1}/${bytes.length}`}:{})});
  let offset=start;const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);res.end();return}res.write(bytes.subarray(offset,offset+20000));offset+=20000},20);
  res.on('close',()=>clearInterval(timer));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
 const port=(server.address() as any).port;
 const spawnMock=t.mock.method(childProcess,'spawn',(_exe:string,args:readonly string[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit('close',null));return true}});
  queueMicrotask(async()=>{await writeFile(args.at(-1)!,'prepared-video');child.stdout.write('out_time_us=20000000\n');child.emit('close',0)});
  return child;
 });
 syncBuiltinESMExports();
 const {MediaCache}=await import('../src/main/media');
 const episode='7695386527160863769';
 const make=(folder:string)=>new MediaCache(folder,'fake-ffmpeg',async id=>({episodeId:id,url:`http://127.0.0.1:${port}/video`,size:bytes.length,definition:'720p',duration:20,codec:'h264',encrypted:false}),{freeBytes:async()=>10*1024**3,progressive:false});
 let media=make(old);await media.init();
 t.after(async()=>{await media.close();spawnMock.mock.restore();syncBuiltinESMExports()});
 const first=media.prepare(episode),firstRejected=assert.rejects(first,{code:'CANCELLED'});
 await until(()=>media.usedBytes>=40000,'partial must accumulate');
 await media.close();await firstRejected;
 media=make(old);await media.init();
 await media.relocate(next,async()=>{});
 const sourceSnapshot=new Map<string,number>();
 for(const name of await readdir(old))sourceSnapshot.set(name,(await stat(path.join(old,name))).size);
 const resumed=await media.prepare(episode);
 assert.ok(requests.some(range=>range.startsWith('bytes=')),'迁移后必须从检查点续传而非重新下载');
 assert.equal(resumed.episodeId,episode);
 // 迁移完成后断点续传不得续写原目录
 assert.deepEqual(new Set(await readdir(old)),new Set(sourceSnapshot.keys()),'原目录不得出现新文件');
 for(const [name,size] of sourceSnapshot)assert.equal((await stat(path.join(old,name))).size,size,`原目录文件 ${name} 不得被续写`);
 // 播放地址指向新目录：删除整个原目录后仍可播放
 await rm(old,{recursive:true,force:true});
 assert.equal((await media.response(resumed.url,null)).status,200);
 // 迁移后的删除指向新目录
 const result=await media.deleteEpisodes([episode]);
 assert.ok(result.freedBytes>0);
 assert.equal((await media.response(resumed.url,null)).status,404);
 assert.equal((await readdir(next)).filter(name=>name.endsWith('.mp4')||name.endsWith('.json')).length,0);
});

test('缓存管理器迁移期间拒绝新任务删除与设置变更，失败回滚后原目录可用，成功后删除指向新目录',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'manju-migrate-manager-'));
 const target=await mkdtemp(path.join(tmpdir(),'manju-migrate-manager-target-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));t.after(()=>rm(target,{recursive:true,force:true}));
 const spawnMock=t.mock.method(childProcess,'spawn',(_exe:string,args:readonly string[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit('close',null));return true}});
  queueMicrotask(async()=>{await writeFile(args.at(-1)!,'prepared-video');child.stdout.write('out_time_us=1000000\n');child.emit('close',0)});
  return child;
 });
 const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response(Buffer.from('source')));
 syncBuiltinESMExports();
 const {MediaCache}=await import('../src/main/media');
 const {CacheManager}=await import('../src/main/cache-manager');
 const mediaDir=path.join(dir,'media-cache');
 const media=new MediaCache(mediaDir,'fake-ffmpeg',async id=>({episodeId:id,duration:1,definition:'540p',codec:'h264',encrypted:false,url:`https://example.com/${id}`,size:6}),{freeBytes:async()=>10*1024**3,concurrency:2});
 await media.init();
 const manager=new CacheManager(dir,media as any);await manager.init();
 t.after(async()=>{await media.close();spawnMock.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports()});
 const work=series('12345678'),episodeIds=work.episodes.map(episode=>episode.id);
 await manager.add(work);
 await until(()=>media.stateFor(episodeIds).ready===2,'background cache must complete');
 // 迁移期间：新下载、删除、暂停恢复、优先级与额度变更都被拒绝
 const next=path.join(target,'HongguoManjuCache');
 const migrating=manager.migrate(next);
 const rejections=[
  manager.add(series('23456789')),
  manager.action(work.id,'delete'),
  manager.action(work.id,'pause'),
  manager.setPriority(work.id,'high'),
  manager.setLimits({maxGiB:1,bandwidthMiB:0}),
 ];
 for(const rejection of rejections)await assert.rejects(rejection,{code:'CACHE_BUSY'});
 const snapshot=await migrating;
 assert.equal(snapshot.directory,next);
 assert.equal(JSON.parse(await readFile(path.join(dir,'cache-settings.json'),'utf8')).directory,next);
 // 迁移后已缓存条目可播放
 const playback=await media.prepare(episodeIds[0]);
 assert.equal((await media.response(playback.url,null)).status,200);
 // 设置提交失败时回滚：目录、设置与已缓存播放保持可用
 await mkdir(path.join(dir,'cache-settings.json.tmp'));
 const second=path.join(target,'second','HongguoManjuCache');
 await assert.rejects(manager.migrate(second),{code:'CACHE_SETTINGS'});
 assert.equal((await manager.snapshot()).directory,next);
 assert.equal(media.location,next);
 assert.equal((await readdir(second)).length,0,'已复制文件必须回滚清理');
 assert.equal((await media.response(playback.url,null)).status,200);
 await rm(path.join(dir,'cache-settings.json.tmp'),{recursive:true});
 // 非专用目录名被拒绝
 await assert.rejects(manager.migrate(path.join(target,'random-name')),{code:'CACHE_PATH'});
 // 迁移后的删除指向新目录，原目录文件保留
 await manager.action(work.id,'delete');
 assert.equal((await manager.snapshot()).tasks.length,0);
 assert.equal((await readdir(next)).filter(name=>name.endsWith('.mp4')).length,0,'新目录缓存必须被删除');
 assert.ok((await readdir(mediaDir)).some(name=>name.endsWith('.mp4')),'原目录文件保留');
});

test('取消等待或占用处理槽的任务后槽位释放且不得写入缓存索引',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'manju-migrate-slots-'));
 // Many partial files are churned quickly; Windows may briefly hold them after close.
 t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 let encodes=0,processing=0,maxProcessing=0;
 const spawnMock=t.mock.method(childProcess,'spawn',()=>{
  encodes++;processing++;maxProcessing=Math.max(maxProcessing,processing);
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit('close',null));return true}});
  child.once('close',()=>processing--);
  return child; // every encode holds until killed
 });
 const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response(Buffer.from('source')));
 syncBuiltinESMExports();
 const {MediaCache}=await import('../src/main/media');
 const media=new MediaCache(dir,'fake-ffmpeg',async id=>({episodeId:id,duration:1,definition:'540p',codec:'h264',encrypted:false,url:`https://example.com/${id}`,size:6}),{freeBytes:async()=>10*1024**3,concurrency:2});
 await media.init();
 t.after(async()=>{await media.close();spawnMock.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports()});
 media.setBackgroundGroups([{id:ids[7],ids:[ids[0],ids[1]],paused:false}]);
 await until(()=>encodes===2,'both processing slots must be held by background jobs');
 // 前台任务抢占一个处理槽
 const first=media.prepare(ids[2]),firstRejected=assert.rejects(first,{code:'CANCELLED'});
 await until(()=>encodes===3,'foreground job must preempt a processing slot');
 // 取消占用槽位的前台任务：槽位必须释放，且不得写入缓存索引
 media.setBufferWindow([]);
 await firstRejected;
 assert.equal(media.stateFor([ids[2]]).ready,0);
 // 被取消任务释放槽位后，后续任务可以获得槽位
 const second=media.prepare(ids[3]),secondRejected=assert.rejects(second,{code:'CANCELLED'});
 await until(()=>encodes>=4,'a later job must acquire the released slot');
 media.setBufferWindow([]);
 await secondRejected;
 assert.equal(media.stateFor([ids[3]]).ready,0);
 assert.ok(maxProcessing<=2,'处理槽并发不得超过两路，释放必须幂等');
 assert.equal((await readdir(dir)).filter(name=>/^[a-f0-9]{32}\.json$/.test(name)).length,0,'被取消任务不得写入缓存索引');
});
