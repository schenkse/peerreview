// Run with node scripts/graph-benchmark.mjs. CHROME_PATH overrides the Chrome binary.
// BENCHMARK_ROOT can point to another checkout for comparable before/after runs.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.BENCHMARK_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!binary) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable');
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__probe', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body></body></html>'); });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'peerreview-dense-'));
const chrome = spawn(binary, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `${origin}/__probe`], { stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let port;
  for (let i=0;i<100;i++) {
    try { port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]; break; } catch { await delay(100); }
  }
  if (!port) throw new Error('Chrome did not start');
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0; const pending=new Map();
  const command=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}));});
  ws.onmessage=({data})=>{const msg=JSON.parse(data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}};
  const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  await command('Page.enable'); await command('Page.navigate', { url: `${origin}/__probe` });
  for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete"')) break; await delay(50); }
  await command('Runtime.enable'); await command('Performance.enable');
  console.log((await command('Browser.getVersion')).product);
  await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await evaluate(`(async()=>{
    const {GraphState}=await import('/src/graph-state.ts');
    const {GraphRenderer}=await import('/src/graph-renderer.ts');
    document.body.innerHTML='<div id="probe" style="width:1280px;height:800px"></div>';
    document.body.dataset.view='graph';
    window.probe={GraphState,GraphRenderer};
    window.frame=()=>new Promise(r=>requestAnimationFrame(r));
    window.stats=values=>{values.sort((a,b)=>a-b);return {median:+values[Math.floor(values.length/2)].toFixed(2),p95:+values[Math.floor(values.length*.95)].toFixed(2)};};
  })()`);
  const heap=async()=>{await command('HeapProfiler.collectGarbage'); const result=await command('Performance.getMetrics');return result.metrics.find(m=>m.name==='JSHeapUsedSize').value/1024**2;};
  for (const [authors,edges] of [[30,100],[500,5000],[500,20000]]) {
    const baseline=await heap();
    const timings=await evaluate(`(async()=>{
      const {GraphState,GraphRenderer}=probe; const graph=new GraphState();
      const renderer=new GraphRenderer(document.getElementById('probe'),graph);
      graph.beginBatch();
      for(let i=1;i<=${authors};i++)graph.addNode({id:String(i),recid:i,name:'Author '+i,isRoot:i===1});
      let added=0;
      // Circulant connections keep degree distribution comparable across runs.
      outer:for(let offset=1;offset<${authors};offset++)for(let i=1;i<=${authors};i++) {
        const j=(i-1+offset)%${authors}+1;
        if(graph.getNeighborIds(String(i)).has(String(j)))continue;
        graph.addOrUpdateEdge(String(i),String(j)); if(++added===${edges})break outer;
      }
      graph.endBatch(); await frame();
      const simulation=renderer.simulation; simulation.stop();
      for(let i=0;i<20;i++){simulation.tick();renderer.ticked();await frame();}
      const layoutWork=[],layoutFrames=[];
      for(let i=0;i<90;i++){
        const start=performance.now();simulation.tick();renderer.ticked();layoutWork.push(performance.now()-start);
        await frame();layoutFrames.push(performance.now()-start);
      }
      const circle=document.querySelector('.node[data-id="1"]'); const hover=[],zoom=[];
      for(let i=0;i<20;i++){
        const start=performance.now();circle.dispatchEvent(new MouseEvent(i%2?'mouseleave':'mouseenter'));await frame();hover.push(performance.now()-start);
        const z=performance.now();renderer.svg.call(renderer.zoom.scaleBy,i%2?1/1.1:1.1);await frame();zoom.push(performance.now()-z);
      }
      // Burst updates expose frame coalescing independently of settled layout.
      let rebuilds=0; const update=renderer.updateSimulation.bind(renderer); renderer.updateSimulation=()=>{rebuilds++;update();};
      const burstStart=performance.now();
      for(let i=0;i<10;i++){const id=String(${authors}+i+1);graph.addNode({id,recid:${authors}+i+1,name:'Added '+i,isRoot:false});}
      await frame(); const burstMs=performance.now()-burstStart; simulation.stop();
      window.activeProbe={graph,renderer};
      return {layoutWorkMs:stats(layoutWork),layoutFrameMs:stats(layoutFrames),hoverFrameMs:stats(hover),zoomFrameMs:stats(zoom),burstRebuilds:rebuilds,burstMs:+burstMs.toFixed(2)};
    })()`);
    const retained=await heap();
    await evaluate(`activeProbe.graph.clear(); activeProbe.renderer.destroy(); document.getElementById('probe').replaceChildren(); delete window.activeProbe;`);
    const cleared=await heap();
    console.log(JSON.stringify({authors,edges,...timings,retainedMiB:+(retained-baseline).toFixed(2),afterClearMiB:+(cleared-baseline).toFixed(2)}));
  }
} finally {
  ws?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
