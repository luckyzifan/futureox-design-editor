import sys,re,json,pathlib,collections,html
path=pathlib.Path(sys.argv[1]);text=path.read_text();section=text.split('Call graph:',1)[1].split('Total number in stack',1)[0]
roots=[];stack=[]
for line in section.splitlines():
 m=re.match(r'^([ +!:|]*)(\d+) (.+)$',line)
 if not m:continue
 depth=len(m[1]);name=re.sub(r'\s+\(in .*$','',m[3]);node={'name':name,'count':int(m[2]),'children':[]}
 while stack and stack[-1][0]>=depth:stack.pop()
 (stack[-1][1]['children']if stack else roots).append(node);stack.append((depth,node))
wait={'read','kevent','__psynch_cvwait','__psynch_mutexwait','__ulock_wait','__ulock_wait2','__workq_kernreturn','mach_msg2_trap','semaphore_wait_trap','__semwait_signal'}
self_counts=collections.Counter();inclusive=collections.Counter()
def visit(n,parents=frozenset()):
 own=max(0,n['count']-sum(c['count']for c in n['children']));n['self']=own
 n['active']=0 if n['name']in wait else own
 self_counts[n['name']]+=n['active']
 for c in n['children']:visit(c,parents|{n['name']});n['active']+=c['active']
 if n['name']not in parents:inclusive[n['name']]+=n['active']
for root in roots:visit(root)
report={'source':str(path),'scope':'native macOS sample call counts; explicit wait leaves excluded from active view, not wall time or physical frame latency','totalThreadSamples':sum(n['count']for n in roots),'nonWaitSamples':sum(n['active']for n in roots),'topSelf':self_counts.most_common(30),'topInclusiveWithoutRecursiveDoubleCount':inclusive.most_common(30),'roots':roots}
path.with_suffix('.summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
data=json.dumps(roots,ensure_ascii=False).replace('<','\\u003c')
page='''<!doctype html><meta charset="utf-8"><title>Native preparation samples</title><style>body{font:14px system-ui;margin:24px;color:#172133;background:#fafbfc}button{padding:6px 12px}svg{width:100%;background:white;border:1px solid #ddd}rect{stroke:white;stroke-width:.5;cursor:pointer}text{pointer-events:none;font:10px monospace}#detail{white-space:pre-wrap}</style><h2>Native preparation · sampled stacks</h2><p>Counts, not milliseconds. The active view excludes explicit wait leaves. Click a frame to zoom.</p><button id="reset">Reset</button> <label><input id="idle" type="checkbox">Include wait samples</label><p id="detail"></p><svg id="flame"></svg><script>const roots=DATA;let focus=roots;const svg=document.querySelector('#flame'),detail=document.querySelector('#detail');function draw(){const key=document.querySelector('#idle').checked?'count':'active',total=focus.reduce((n,r)=>n+r[key],0)||1;let output='',max=0;function row(n,x,w,d){if(w<.3||!n[key])return;max=Math.max(max,d);const hue=[...n.name].reduce((a,c)=>(a+c.charCodeAt(0)*13)%70,0);const id=nodes.push(n)-1;output+=`<g data-id="${id}"><rect x="${x}" y="${d*20}" width="${w}" height="19" fill="hsl(${hue},85%,72%)"/>`;if(w>50)output+=`<text x="${x+3}" y="${d*20+13}">${esc(n.name.slice(0,Math.floor(w/6)))}</text>`;output+='</g>';let next=x;for(const child of n.children){const cw=w*child[key]/n[key];row(child,next,cw,d+1);next+=cw}}nodes=[];let x=0;for(const r of focus){const w=1200*r[key]/total;row(r,x,w,0);x+=w}svg.setAttribute('viewBox',`0 0 1200 ${(max+1)*20}`);svg.innerHTML=output;for(const el of svg.querySelectorAll('g')){const n=nodes[+el.dataset.id];el.onmouseenter=()=>detail.textContent=`${n.name}\n${n[key]} samples · self ${n.self}`;el.onclick=()=>{focus=[n];draw()}}}function esc(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}let nodes=[];document.querySelector('#reset').onclick=()=>{focus=roots;draw()};document.querySelector('#idle').onchange=draw;draw();</script>'''.replace('DATA',data)
path.with_suffix('.flames.html').write_text(page)
print(json.dumps({k:v for k,v in report.items()if k not in ['roots','topSelf','topInclusiveWithoutRecursiveDoubleCount']},ensure_ascii=False))
print('Top inclusive:',inclusive.most_common(12))
