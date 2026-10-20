import { paint } from '../../design-client/src/model'
import type { Json } from './ai-generation-client'

/** Original synthetic management UI. Every element is authored as an MCP operation. */
export function composeOps(firstPage: string) {
  const names = ['Overview', 'Users', 'Projects', 'Settings', 'Analytics Wall']
  const pages = names.map((_, i) => i ? `71000000-0000-4000-8000-${String(i).padStart(12, '0')}` : firstPage)
  const operations: Json[] = [], roots: string[] = [], refs: Record<string, string> = {}
  let seq = 0
  const id = () => `72000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
  const c = { bg: '#f3f5fa', white: '#ffffff', ink: '#17223b', muted: '#6b7892', line: '#e6ebf4', blue: '#4167ed', mint: '#d9f5e8', green: '#197d58', dark: '#0b1428', panel: '#14213b', cyan: '#68def1' }
  function box(parentId: string, name: string, x: number, y: number, width: number, height: number, fill: string, r = 0, kind = 'frame') {
    const nodeId = id(); operations.push({ method: 'node.create', params: { id: nodeId, parentId, kind, x, y, width, height, patch: { name, fills: [paint(fill)], radii: [r, r, r, r] } } }); return nodeId
  }
  function txt(parent: string, value: string, x: number, y: number, w: number, size = 14, fill = c.ink, weight = 400, h = size * 1.6) {
    const n = box(parent, value.slice(0, 70), x, y, w, h, fill, 0, 'text'); operations.push({ method: 'text.set', params: { ids: [n], text: value, fontSize: size, textStyle: { fontId: 'ops-noto', weight, lineHeight: 1.25, wrap: false } } }); return n
  }
  function badge(parent: string, label: string, x: number, y: number, w = 94, dark = false) {
    const n = box(parent, `${label} status`, x, y, w, 28, dark ? '#203c46' : c.mint, 14); txt(n, label, 12, 5, w - 20, 11, dark ? c.cyan : c.green, 600, 20); return n
  }
  function button(parent: string, label: string, x: number, y: number, w = 144) {
    const n = box(parent, label, x, y, w, 42, c.blue, 8); txt(n, label, 17, 10, w - 26, 13, c.white, 600); return n
  }
  function divider(parent: string, x: number, y: number, w: number, dark = false) { box(parent, 'Divider', x, y, w, 1, dark ? '#263550' : c.line, 0, 'rectangle') }
  function card(parent: string, name: string, x: number, y: number, w: number, h: number, dark = false) { return box(parent, name, x, y, w, h, dark ? c.panel : c.white, 12) }
  function bars(parent: string, x: number, y: number, w: number, h: number, values: number[], dark = false) {
    for (let j = 0; j < 4; j++) divider(parent, x, y + j * h / 3, w, dark)
    const step = w / values.length
    values.forEach((v, i) => { box(parent, `Volume sample ${i + 1}: ${v}`, x + i * step + 7, y + h - v / 100 * h, step - 14, v / 100 * h, dark ? (i % 3 ? '#3f84c9' : c.cyan) : (i === values.length - 1 ? c.blue : '#bccafa'), 4, 'rectangle') })
  }
  function shell(i: number) {
    const root = box(pages[i], `${names[i]} / 1440 x 1000`, 0, 0, 1440, 1000, c.bg); roots.push(root)
    const nav = box(root, 'Persistent sidebar', 0, 0, 224, 1000, c.white)
    box(nav, 'Brand square', 26, 30, 32, 32, c.blue, 8); txt(nav, 'F', 36, 31, 20, 21, c.white, 700)
    txt(nav, 'futureox', 70, 29, 140, 24, c.ink, 700); txt(nav, 'OPERATIONS / DEMO', 27, 86, 180, 10, c.muted, 600)
    names.slice(0, 4).forEach((name, j) => { if (j === i) box(nav, 'Selected navigation', 16, 137 + j * 52, 192, 42, '#edf1ff', 8); box(nav, 'Navigation indicator', 30, 151 + j * 52, 12, 12, j === i ? c.blue : '#a7b3cb', 3, 'rectangle'); txt(nav, name, 56, 146 + j * 52, 144, 14, j === i ? c.blue : c.muted, j === i ? 600 : 400) })
    divider(nav, 24, 369, 176); txt(nav, 'WORKSPACE', 28, 391, 160, 10, c.muted, 600); txt(nav, 'Atlas product team', 28, 421, 175, 13)
    const local = card(nav, 'Local-only demo notice', 16, 802, 192, 108); box(local, 'Notice background', 0, 0, 192, 108, '#f2f5fb', 10); txt(local, 'Made for focused work', 14, 17, 168, 12, c.ink, 600); txt(local, 'Synthetic data · Local only', 14, 46, 171, 11, c.muted)
    txt(nav, 'AM', 29, 940, 35, 12, c.blue, 700); txt(nav, 'Alex Morgan', 67, 934, 140, 12, c.ink, 600); txt(nav, 'Workspace admin', 67, 954, 140, 10, c.muted)
    txt(root, 'WORKSPACE  /  ' + names[i].toUpperCase(), 264, 31, 700, 11, c.muted, 600)
    txt(root, 'Search anything...', 1040, 28, 210, 12, c.muted); badge(root, 'DEMO', 1300, 25, 92)
    divider(root, 264, 78, 1136); txt(root, names[i], 264, 106, 780, 32, c.ink, 700, 52)
    txt(root, ['A clear view of your team, delivery, and momentum.', 'The right people. The right access.', 'From first idea to confident delivery.', 'Make this workspace work for your team.'][i], 265, 165, 900, 14, c.muted)
    return root
  }
  pages.forEach((page, i) => operations.push({ method: i ? 'page.create' : 'page.update', params: i ? { id: page, name: names[i] } : { id: page, patch: { name: names[i] } } }))
  const overview = shell(0)
  refs.title = txt(overview, 'October performance', 264, 225, 700, 19, c.ink, 600)
  const stats = [['Active users', '12,840', '+12.8% this month'], ['Open projects', '48', '8 ready for review'], ['Monthly revenue', '$84,250', '+8.2% this month'], ['System uptime', '99.98%', 'All services healthy']]
  stats.forEach((s, i) => { const n = card(overview, s[0], 264 + i * 288, 270, 272, 138); txt(n, s[0], 20, 17, 234, 12, c.muted); txt(n, s[1], 20, 43, 234, 30, c.ink, 700); txt(n, s[2], 20, 102, 234, 11, c.green, 500) })
  const chart = card(overview, 'Revenue chart', 264, 432, 744, 296); txt(chart, 'Revenue trend', 24, 18, 420, 17, c.ink, 600); txt(chart, 'Last 12 months  /  USD thousands', 24, 50, 560, 11, c.muted)
  bars(chart, 24, 98, 696, 144, [32, 40, 36, 51, 46, 65, 60, 74, 69, 83, 79, 94]); ['JAN','APR','JUL','OCT'].forEach((label,i)=>txt(chart,label,30+i*210,257,60,10,c.muted))
  const pulse = card(overview, 'Team pulse', 1032, 432, 368, 296); txt(pulse, 'Team pulse', 24, 18, 320, 17, c.ink, 600)
  ;[['Design', 82], ['Engineering', 68], ['Operations', 94]].forEach(([label, v], i) => { txt(pulse, String(label), 24, 76 + i * 66, 220, 12); txt(pulse, `${v}%`, 283, 76 + i * 66, 62, 12, c.muted); box(pulse, 'Progress track', 24, 108 + i * 66, 320, 6, c.line, 3, 'rectangle'); box(pulse, `${label} progress`, 24, 108 + i * 66, Number(v) * 3.2, 6, c.blue, 3, 'rectangle') })
  const activity = card(overview, 'Recent activity', 264, 752, 1136, 192); txt(activity, 'Recent activity', 24, 18, 820, 17, c.ink, 600)
  ;['Maya Chen published the mobile design system', 'Noah Wilson completed the API reliability review', 'Sofia Patel invited 3 team members'].forEach((s, i) => { box(activity, 'Activity marker', 25, 71 + i * 37, 7, 7, c.blue, 3, 'ellipse'); txt(activity, s, 47, 61 + i * 37, 850, 12); txt(activity, `${i * 12 + 4} min ago`, 990, 61 + i * 37, 120, 11, c.muted) })
  const users = shell(1); button(users, '+ Invite member', 1232, 112, 168)
  const table = card(users, 'Members table', 264, 232, 1136, 622); txt(table, 'Team members', 24, 20, 600, 18, c.ink, 600); txt(table, '8 members · 3 teams', 24, 56, 700, 12, c.muted)
  const columns = [24, 340, 580, 790, 970]; ['MEMBER', 'ROLE', 'TEAM', 'STATUS', 'LAST ACTIVE'].forEach((s, i) => txt(table, s, columns[i], 109, i===4?140:185, 10, c.muted, 600)); divider(table, 24, 145, 1088)
  const members = [['Maya Chen','maya@example.test','Admin','Design','2 min ago'], ['Noah Wilson','noah@example.test','Editor','Engineering','12 min ago'], ['Sofia Patel','sofia@example.test','Editor','Operations','25 min ago'], ['Ethan Park','ethan@example.test','Viewer','Design','1 hour ago'], ['Olivia Reed','olivia@example.test','Editor','Engineering','2 hours ago'], ['Lucas Brown','lucas@example.test','Viewer','Operations','3 hours ago']]
  members.forEach((m, i) => { const y = 162 + i * 66; box(table, `${m[0]} avatar`, 24, y + 3, 34, 34, ['#e5eaff','#e0f3ef','#f7e9df'][i%3], 17); txt(table, m[0].split(' ').map(n=>n[0]).join(''), 32, y+11, 28, 10, c.blue, 600); txt(table,m[0],72,y,250,13,c.ink,600);txt(table,m[1],72,y+24,250,10,c.muted);txt(table,m[2],340,y+9,200,12);txt(table,m[3],580,y+9,200,12);const b=badge(table,'Active',790,y+3,84);if(i===0) refs.badge=b;txt(table,m[4],970,y+9,140,11,c.muted);divider(table,24,y+54,1088) })
  txt(users, 'Showing 6 of 8 members', 288, 885, 600, 12, c.muted); txt(users, 'Previous     1     2     Next', 1150, 885, 250, 12, c.blue)
  const projects=shell(2);button(projects,'+ New project',1238,112,162)
  const projectData=[['Atlas redesign','Product experience','#e9eefe','74%','Maya Chen'],['Platform API','Developer tools','#e4f4ef','58%','Noah Wilson'],['Launch toolkit','Go-to-market','#f8ece0','92%','Sofia Patel'],['Mobile workspace','Mobile experience','#f1e9fa','42%','Ethan Park'],['Data foundations','Infrastructure','#e4f0fa','68%','Olivia Reed'],['Customer insights','Research','#f8e9ed','85%','Lucas Brown']]
  projectData.forEach((p,i)=>{const n=card(projects,p[0],264+(i%3)*386,232+Math.floor(i/3)*332,364,306);box(n,'Project visual',20,20,324,100,p[2],8);for(let k=0;k<4;k++)box(n,'Editable project motif',44+k*65,45+(k%2)*12,45,45,c.blue,8,'rectangle');txt(n,p[0],20,140,324,19,c.ink,600);txt(n,p[1],20,176,324,12,c.muted);txt(n,`${p[3]} complete`,20,214,324,11,c.muted);box(n,'Progress track',20,244,324,5,c.line,2,'rectangle');box(n,'Project progress',20,244,parseInt(p[3])*3.24,5,c.blue,2,'rectangle');txt(n,p[4],20,267,235,11);txt(n,'Oct 28',275,267,76,11,c.muted)})
  const settings=shell(3); const general=card(settings,'Workspace preferences',264,232,744,660);txt(general,'Workspace preferences',24,21,650,20,c.ink,600);txt(general,'Update the basics for everyone in your workspace.',24,61,680,12,c.muted)
  ;[['Workspace name','Atlas product team'],['Workspace URL','futureox.local / atlas'],['Default timezone','UTC — Coordinated Universal Time'],['Language','English (United States)']].forEach((p,i)=>{const y=116+i*107;txt(general,p[0],24,y,650,12,c.ink,500);box(general,'Input field',24,y+31,696,44,'#f5f7fb',7);txt(general,p[1],38,y+42,660,13,c.muted)})
  button(general,'Save changes',24,584,152);txt(general,'Changes apply to this demo workspace.',200,595,470,11,c.muted)
  const security=card(settings,'Access and notifications',1032,232,368,418);txt(security,'Access & notifications',24,22,320,18,c.ink,600)
  ;[['Two-step verification','Recommended for all members'],['Project notifications','Delivery and review updates'],['Weekly digest','A summary every Monday']].forEach((p,i)=>{txt(security,p[0],24,88+i*100,260,13,c.ink,600);txt(security,p[1],24,117+i*100,315,11,c.muted);box(security,'Enabled toggle',286,87+i*100,38,22,c.blue,11);box(security,'Toggle thumb',305,90+i*100,16,16,c.white,8,'ellipse')})
  const wall=box(pages[4],'Analytics wall / 1920 x 1080',0,0,1920,1080,c.dark);roots.push(wall)
  txt(wall,'FUTUREOX  /  OPERATIONS INTELLIGENCE',40,26,1250,27,c.white,700,48);txt(wall,'TUESDAY 20 OCTOBER 2026     •     SYNTHETIC DEMO DATA',40,82,1300,13,'#8b9fbd',500);badge(wall,'LIVE DEMO',1730,37,145,true)
  divider(wall,40,128,1840,true)
  ;[['TOTAL EVENTS','2.48M','+18.4% vs prior period'],['ACTIVE REGIONS','24','All regions reporting'],['SUCCESS RATE','99.94%','+0.12 percentage points'],['P95 LATENCY','128 ms','-16 ms vs prior period']].forEach((s,i)=>{const n=card(wall,s[0],40+i*468,156,436,160,true);txt(n,s[0],24,20,388,12,'#8b9fbd',600);txt(n,s[1],24,50,388,39,c.white,700,64);txt(n,s[2],24,121,388,12,c.cyan)})
  const traffic=card(wall,'Hourly event volume',40,344,1200,348,true);txt(traffic,'Hourly event volume',26,20,1000,22,c.white,600);txt(traffic,'24 HOUR WINDOW  /  THOUSANDS OF EVENTS',26,63,1100,12,'#8b9fbd');bars(traffic,28,114,1144,176,[26,22,18,21,29,40,58,72,86,79,70,64,76,89,96,87,79,68,73,82,74,61,44,36],true);['00:00','06:00','12:00','18:00','23:00'].forEach((label,i)=>txt(traffic,label,30+i*271,310,70,12,'#8b9fbd'))
  const regions=card(wall,'Regional distribution',1264,344,616,348,true);txt(regions,'Regional distribution',26,20,560,22,c.white,600)
  ;[['North America',42],['Europe',31],['Asia Pacific',19],['Other regions',8]].forEach(([name,v],i)=>{txt(regions,String(name),26,81+i*62,460,14,'#cad6e8');txt(regions,`${v}%`,520,81+i*62,80,14,c.cyan);box(regions,'Region bar track',26,111+i*62,562,6,'#263550',3,'rectangle');box(regions,'Region bar',26,111+i*62,Number(v)*12,6,c.cyan,3,'rectangle')})
  const services=card(wall,'Service health',40,720,1200,288,true);txt(services,'Service health',26,20,1100,22,c.white,600)
  ;['API gateway','Event pipeline','Object storage','Identity service'].forEach((name,i)=>{const x=26+i*292;box(services,'Healthy dot',x,84,9,9,'#69d8ae',4,'ellipse');txt(services,name,x+20,75,250,16,c.white,600);txt(services,['32 ms','84 ms','18 ms','46 ms'][i],x,120,260,30,c.cyan,600);txt(services,'Average response',x,174,260,12,'#8b9fbd');txt(services,'Operational · 100% availability',x,225,270,12,'#69d8ae')})
  const alerts=card(wall,'Incident summary',1264,720,616,288,true);txt(alerts,'Incident summary',26,20,560,22,c.white,600);txt(alerts,'All systems operational',26,89,560,25,'#69d8ae',600);txt(alerts,'No open incidents in this demo period.',26,139,560,14,'#8b9fbd');txt(alerts,'Last resolved  /  Oct 18, 14:32 UTC',26,213,560,13,'#cad6e8')
  txt(wall,'LOCAL DESIGN EXERCISE  ·  NO LIVE DATA CONNECTION',40,1034,1500,11,'#6f86a8',500)
  refs.alpha=box(wall,'Translucent cyan accent',1724,1034,156,6,'#68def1',3,'rectangle')
  operations.push({method:'node.update',params:{ids:[refs.alpha],patch:{fills:[{...paint('#68def1'),opacity:0.5}]}}})
  return { names,pages,roots,refs,operations,designedNodeCount:seq }
}
