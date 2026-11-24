import catalog from './projects.js';
import { demoSnapshot, total } from './demo.js';
import { icon, mountIcons } from './icons.js';

const $ = selector => document.querySelector(selector);
const views = { overview:'Overview', projects:'OpenMVP Stat', events:'Events', attribution:'Attribution', features:'Behavior', reports:'Reports', sources:'Data sources', exports:'Exports', mcp:'MCP for agents', goals:'Goals' };
const state = { mode:'demo', project:'', tag:'', days:1, offset:0, period:'today', model:'last', report:'summary', standardReport:'traffic', reportReady:false, goalConfig:null, goalConfigLoaded:false, search:'', snapshot:null, error:'', busy:false };
const numbers = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 });
const dateLabel = new Intl.DateTimeFormat('en-US', { day:'numeric', month:'short', timeZone:'UTC' });
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const num = value => numbers.format(Number(value || 0));
const countryNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type:'region' }) : null;
const countryLabel = code => {
  if (!code || code === 'ZZ') return 'Unknown';
  try { return countryNames?.of(code) || code; } catch { return code; }
};
const trafficLabel = value => ({ human:'Humans · likely', bot:'Bots', unknown:'Unknown' })[value] || 'Unknown';
const names = { 'Organic search':'Organic search', 'Paid search':'Paid search', Direct:'Direct', 'Partner referral':'Partner referral' };
const channelName = channel => names[channel] || channel || 'Direct';
const fmtDate = value => dateLabel.format(new Date(value));
const safeUrl = value => {
  if (!value) return '';
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
const domain = url => { const valid = safeUrl(url); return valid ? new URL(valid).hostname : 'No domain'; };
function demoProjects() {
  try {
    const items = JSON.parse(localStorage.getItem('vibemetrics.projects') || '[]');
    return [...catalog, ...items];
  } catch { return [...catalog]; }
}

let projects = demoProjects();
let requestNumber = 0;
let toastTimer;
const viewNode = $('#view');
const base = location.pathname.startsWith('/panel/') ? '/panel/' : location.pathname.startsWith('/app/') ? '/app/' : '/';
const route = () => {
  const rel = (location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname).replace(/^\/+|\/+$/g, '');
  const page = ({ ai:'reports' })[rel] || rel;
  const params = new URLSearchParams(location.search);
  return { page: Object.hasOwn(views, page) ? page : 'overview', project: params.get('project') || '', tag: params.get('tag') || '', report: params.get('report') || '' };
};
const projectHref = (page, project, tag = '', extras = {}) => {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (tag) params.set('tag', tag);
  for (const [key, value] of Object.entries(extras)) if (value) params.set(key, value);
  const query = params.toString();
  return base + (page === 'overview' ? '' : page) + (query ? '?' + query : '');
};
const selection = () => projects.find(project => project.id === state.project);
const button = (action, label, glyph, style = '') => `<button class="button ${style}" type="button" data-action="${action}">${glyph ? icon(glyph) : ''}${label}</button>`;
const link = (page, label) => `<a class="text-link" href="${projectHref(page, state.project, state.tag)}">${label} <span aria-hidden="true">↗</span></a>`;
const parseTags = value => [...new Set(String(value || '').split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 8).map(tag => tag.slice(0, 40));
const GOAL_NAME_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const parseGoals = value => [...new Set(String(value || '').split(',').map(name => name.trim()).filter(Boolean))].slice(0, 50).map(name => name.slice(0, 80));
const isPanel = () => location.pathname.startsWith('/panel/');
const table = (head, rows, empty = 'No data for this period yet.') => `<div class="table-wrap"><table><thead><tr>${head.map(title => {
  const label = typeof title === 'object' ? title.t : title;
  return `<th scope="col"${typeof title === 'object' && title.n ? ' class="number"' : ''}>${label}</th>`;
}).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.join('')}</tr>`).join('') : `<tr><td class="empty" colspan="${head.length}">${empty}</td></tr>`}</tbody></table></div>`;
const cell = (value, numeric = false) => `<td${numeric ? ' class="number"' : ''}>${escape(value)}</td>`;
const panel = (title, detail, content, action = '') => `<section class="panel"><div class="panel-head"><div><h2>${title}</h2>${detail ? `<p>${detail}</p>` : ''}</div>${action}</div>${content}</section>`;
const callout = (html, warn = false) => `<div class="callout${warn ? ' warn' : ''}">${html}</div>`;
const dateRange = () => {
  const daily = state.snapshot?.daily || [];
  return daily.length ? fmtDate(daily[0].date) + ' — ' + fmtDate(daily.at(-1).date) : '';
};
const mode = () => `<span class="mode${state.error ? ' warn' : ''}"><i class="status-dot"></i>${state.error ? 'No connection' : state.mode === 'live' ? 'ClickHouse data' : 'Demo data'}</span>`;

function controls() {
  return `<div class="tools-row"><div class="control-group">${mode()}<span class="quiet">${dateRange()}</span></div><div class="control-group">
    <select id="project-select" aria-label="Project"><option value="">All projects</option>${projects.map(p => `<option value="${escape(p.id)}"${p.id === state.project ? ' selected' : ''}>${escape(p.name)}</option>`).join('')}</select>
    <select id="period-select" aria-label="Period">${[['today','Today'],['yesterday','Yesterday'],[7,'7 days'],[14,'14 days'],[30,'30 days']].map(([value,label]) => `<option value="${value}"${String(value) === String(state.period) ? ' selected' : ''}>${label}</option>`).join('')}</select>
    ${button('csv','Download CSV','download')}
  </div></div>`;
}

function hero() {
  const steps = [['pulse','Events'],['database','ClickHouse'],['link','CRM'],['terminal','MCP / AI']];
  return `<section class="hero"><div><span class="eyebrow">IN-HOUSE PRODUCT ANALYTICS</span><h1>The whole network in numbers.</h1><p>Collect events in your own ClickHouse, link visits to CRM deals, and hand agents the data for reports over MCP.</p></div>
    <div class="flow" aria-label="Events, ClickHouse, CRM and MCP">${steps.map(([glyph, label]) => `<div class="flow-step">${icon(glyph)}${label}</div>`).join('<span class="flow-arrow" aria-hidden="true">→</span>')}</div></section>`;
}

function kpis() {
  const list = state.snapshot.projects;
  const cards = state.mode === 'live' ? [
    ['Pageviews', num(total(list,'pageviews')), 'One record per pageview; updated on exit', 'pulse'],
    ['Visitors', num(total(list,'visitors')), 'Unique across the selected sites', 'users'],
    ['Humans · likely', num(total(list,'human_visitors')), 'By browser User-Agent', 'target'],
    ['Bots', num(total(list,'bot_visitors')), 'UA matched a known bot signature', 'layers'],
    ['Goal 1', num(total(list,'goal1')), 'JS event Goal1 sent by sites', 'target'],
    ['Goal 2', num(total(list,'goal2')), 'JS event Goal2 sent by sites', 'target'],
  ] : [
    ['Events', num(total(list,'events')), 'Actions across sites and apps', 'pulse'],
    ['Sessions', num(total(list,'sessions')), 'Sessions within projects', 'users'],
    ['Conversions', num(total(list,'conversions')), 'Goal events in the period', 'target'],
    ['Linked to CRM', total(list,'conversions') ? Math.round(100 * total(list,'linked') / total(list,'conversions')) + '%' : '—', num(total(list,'linked')) + ' conversions with a CRM deal', 'link'],
  ];
  return `<div class="kpis">${cards.map(([title,value,note,glyph]) => `<div class="kpi"><div class="kpi-top"><span>${title}</span>${icon(glyph)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`).join('')}</div>`;
}

function chart() {
  const { daily, previous } = state.snapshot;
  const metric = state.mode === 'live' ? 'pageviews' : 'events';
  const unit = state.mode === 'live' ? 'pageviews' : 'events';
  const value = point => Number(point[metric] || 0);
  if (!daily.some(point => value(point)) && !previous.some(point => value(point))) return `<p class="empty">${state.mode === 'live' ? 'No pageviews yet.' : 'No events yet. Pick another project or period.'}</p>`;
  const ceiling = Math.max(1, ...daily.concat(previous).map(value));
  const tick = 10 ** Math.floor(Math.log10(ceiling)) / 2;
  const top = Math.ceil(ceiling / tick) * tick;
  const points = series => series.map((p, i) => [45 + 562 * i / Math.max(1, series.length - 1), 146 - 122 * value(p) / top]);
  const coords = points(daily);
  const line = series => series.map(([x,y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const area = '45,146 ' + line(coords) + ' 607,146';
  const guides = [0, .25, .5, .75, 1].map(n => {
    const y = 146 - n * 122;
    return `<line class="guide" x1="45" y1="${y}" x2="607" y2="${y}"/><text x="38" y="${y+3}" text-anchor="end">${compact.format(top*n)}</text>`;
  });
  const labels = coords.map(([x],i) => (i === 0 || i === coords.length-1 || i % Math.ceil(coords.length/6) === 0) && (i === coords.length-1 || i < coords.length-2) ? `<text x="${x}" y="166" text-anchor="${i === 0 ? 'start' : i === coords.length-1 ? 'end' : 'middle'}">${fmtDate(daily[i].date)}</text>` : '');
  return `<div class="chart"><svg viewBox="0 0 625 178" role="img" aria-label="${state.mode === 'live' ? 'Pageviews' : 'Events'} per day with previous period">
    <defs><linearGradient id="volume-fill" x1="0" x2="0" y1="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#91c8ae" stop-opacity=".49"/><stop offset="1" stop-color="#e0f1e9" stop-opacity=".17"/></linearGradient></defs>
    ${guides.join('')}<polygon points="${area}" fill="url(#volume-fill)"/><polyline points="${line(points(previous))}" class="compare"/><polyline points="${line(coords)}" class="series"/>
    ${coords.map(([x,y],i) => `<circle cx="${x}" cy="${y}" r="3" fill="#267f68"><title>${fmtDate(daily[i].date)} · ${num(value(daily[i]))} ${unit}</title></circle>`).join('')}${labels.join('')}</svg></div>`;
}

function channels() {
  const rows = state.snapshot.attribution.slice(0,5);
  const count = total(state.snapshot.attribution,'conversions');
  if (!count) return '<p class="empty">No conversions yet.</p>';
  return `<div class="channel-list">${rows.map(row => {
    const percent = Math.round(100 * row.conversions / count);
    return `<div class="channel"><strong>${escape(channelName(row.channel))}</strong><b>${percent}%</b><div class="track"><i style="width:${percent}%"></i></div></div>`;
  }).join('')}</div>`;
}

function projectTable(rows) {
  const live = state.mode === 'live';
  const ranked = [...rows].sort((a,b) => Number(live ? b.pageviews : b.events) - Number(live ? a.pageviews : a.events) || a.name.localeCompare(b.name));
  const perVisitor = row => Number(row.visitors) ? num(Math.round(Number(row.pageviews) / Number(row.visitors) * 10) / 10) : '—';
  const headers = live ? ['Project','Stream',{t:'Pageviews',n:1},{t:'Visitors',n:1},{t:'Sessions',n:1},{t:'Pageviews / visitor',n:1},{t:'Active time',n:1},{t:'Scroll depth',n:1},{t:'Humans',n:1},{t:'Bots',n:1},{t:'Unidentified',n:1},{t:'Conversions',n:1},{t:'Goal 1',n:1},{t:'Goal 2',n:1},{t:'CRM',n:1},'']
    : ['Project','Stream',{t:'Events',n:1},{t:'Sessions',n:1},{t:'Conversions',n:1},{t:'CRM',n:1},''];
  return table(headers, ranked.map(row => {
    const color = /^#[0-9a-f]{6}$/i.test(row.color) ? row.color : '#3a7864';
    const count = Number(live ? row.pageviews : row.events) || 0;
    const common = [
      `<td><div class="project-cell"><span class="project-mark" style="--mark:${color}">${escape(row.mark || row.name[0])}</span><div><a href="${projectHref('overview',row.id)}">${escape(row.name)}</a><small>${escape(domain(row.url))}</small>${(row.tags || []).map(tag => `<small class="row-tag">${escape(tag)}</small>`).join('')}</div></div></td>`,
      `<td><span class="tag${count ? ' on' : ''}">${count ? (state.mode === 'demo' ? 'Demo stream' : 'Has traffic') : 'Waiting for traffic'}</span></td>`,
    ];
    const metrics = live
      ? [cell(num(row.pageviews),true),cell(num(row.visitors),true),cell(num(row.sessions),true),cell(perVisitor(row),true),
         cell(row.avg_time_seconds ? num(row.avg_time_seconds) + ' s' : '—',true),
         cell(row.avg_scroll_depth ? num(row.avg_scroll_depth) + '%' : '—',true),
         cell(num(row.human_visitors),true),cell(num(row.bot_visitors),true),cell(num(row.unknown_visitors),true),cell(num(row.conversions),true),cell(num(row.goal1),true),cell(num(row.goal2),true),cell(row.conversions ? num(row.linked) + ' / ' + num(row.conversions) : '—',true)]
      : [cell(num(row.events),true),cell(num(row.sessions),true),cell(num(row.conversions),true),cell(row.conversions ? num(row.linked) + ' / ' + num(row.conversions) : '—',true)];
    return [...common,...metrics,`<td class="row-actions"><a class="text-link" href="${projectHref('overview',row.id)}" aria-label="Open ${escape(row.name)}">Open ↗</a><a class="text-link" href="${projectHref('reports',row.id,'',{report:'countries'})}" title="Countries report">Countries ↗</a><a class="text-link" href="${projectHref('reports',row.id,'',{report:'events'})}" title="Event types report">Events ↗</a><a class="text-link" href="${projectHref('goals',row.id)}" title="Goals">Goals ↗</a><button class="button" type="button" data-action="tags" data-id="${escape(row.id)}">Tags</button></td>`];
  }), 'No projects found.');
}

function modules() {
  return `<div class="modules section-gap">${[
    ['route','End-to-end attribution','First and last touch, conversions, and the share of conversions linked to a CRM deal.','attribution','Open attribution'],
    ['layers','Behavioral features','Engaged sessions, returning visitors, and the share of sessions with a goal action.','features','View features'],
    ['terminal','Project reports','Traffic, countries, pages, sources, and events; the catalog grows through the report registry.','reports','Open reports'],
  ].map(([glyph,title,copy,page,label]) => `<section class="panel module">${icon(glyph)}<h2>${title}</h2><p>${copy}</p>${link(page,label)}</section>`).join('')}</div>`;
}

function pageHead(title, copy, action = '') {
  return `<div class="page-head"><div><span class="eyebrow">VIBEMETRICS / WORKSPACE</span><h1>${title}</h1><p>${copy}</p></div>${action}</div>`;
}

function pagesPanel() {
  const rows = (state.snapshot.pages || []).map(row => [
    cell(row.page), cell(num(row.views),true), cell(num(row.visitors),true),
    cell(row.avg_time_seconds ? num(row.avg_time_seconds) + ' s' : '—'),
    cell(row.avg_scroll_depth ? num(row.avg_scroll_depth) + '%' : '—'),
  ]);
  return panel('Pages','Pageviews, visitors, active time, and scroll depth.',
    table(['Page','Pageviews','Visitors','Avg time','Depth'],rows,'No page_view events yet.'));
}

function hourPanel() {
  const data = state.snapshot.hourly || [];
  if (!data.some(point => point.visitors)) return '';
  const top = Math.max(1, ...data.map(point => point.visitors));
  const cols = data.map(point => `<div class="hour-col"><i style="height:${Math.round(100 * point.visitors / top)}%" title="${point.hour}:00 UTC — ${num(point.visitors)}"></i><span>${point.hour}</span></div>`).join('');
  return panel('Visitors by hour','Unique visitors by hour of day (UTC) within the selected period.',`<div class="hourly">${cols}</div>`);
}

function shareBars(rows, emptyText) {
  const totalSum = rows.reduce((acc, r) => acc + Number(r.visitors || 0), 0) || 1;
  return `<div class="channel-list">${rows.map(r => {
    const pct = Math.round(100 * Number(r.visitors || 0) / totalSum);
    return `<div class="channel"><strong>${escape(r.title)}</strong><b>${pct}%</b><div class="track"><i style="width:${pct}%"></i></div><small>${num(r.visitors)} · ${num(r.pageviews)} pageviews</small></div>`;
  }).join('')}</div>`;
}

function trafficPanel() {
  const rows = (state.snapshot.traffic || []).map(r => ({ ...r, title: trafficLabel(r.traffic_type) }));
  if (!rows.length) return '';
  return panel('Traffic type','Visitor classification by User-Agent heuristic — not absolute.',shareBars(rows));
}

function countriesPanel() {
  const rows = (state.snapshot.countries || []).slice(0, 10).map(r => ({ ...r, title: countryLabel(r.country_code) }));
  if (!rows.length) return '';
  return panel('Countries','Visitors by country of their last page_view (GeoIP, approximate).',shareBars(rows));
}

function devicesPanel() {
  const rows = (state.snapshot.devices || []).map(r => ({ ...r, title: { desktop:'Desktop', mobile:'Mobile', tablet:'Tablet', unknown:'Unidentified' }[r.device_type] || r.device_type }));
  if (!rows.length) return '';
  return panel('Devices','Visitors by device type (User-Agent). Historical events before this field may show as Unidentified.',shareBars(rows));
}

function dashboardGrid() {
  return `<div class="analytics-grid section-gap">${hourPanel()}${trafficPanel()}${devicesPanel()}${countriesPanel()}${engagementPanel()}${topEventsPanel()}</div>`;
}

function engagementPanel() {
  const features = state.snapshot.features || [];
  const value = name => {
    const row = features.find(item => item.feature === name);
    return row ? num(row.value) : '—';
  };
  if (!features.length) return '';
  return panel('Engagement and returns','Session quality metrics within the selected period.',
    table(['Metric','Value'],[
      [cell('Engaged sessions (active time + JS activity)'),cell(value('Engaged sessions'),true)],
      [cell('Returning visitors (2+ sessions)'),cell(value('Returning visitors'),true)],
      [cell('Sessions with a conversion'),cell(value('Sessions with a conversion'),true)],
      [cell('Goal 1 (JS event)'),cell(value('Goal 1'),true)],
      [cell('Goal 2 (JS event)'),cell(value('Goal 2'),true)],
      [cell('Average active time on page'),cell(features.find(item => item.feature === 'Active time on page, s') ? value('Active time on page, s') + ' s' : '—',true)],
      [cell('Average active time on site'),cell(features.find(item => item.feature === 'Active time on site, s') ? value('Active time on site, s') + ' s' : '—',true)],
      [cell('Average scroll depth'),cell(features.find(item => item.feature === 'Average scroll depth, %') ? value('Average scroll depth, %') + '%' : '—',true)],
    ]));
}

function topEventsPanel() {
  const rows = (state.snapshot.top_events || []).slice(0, 10);
  if (!rows.length) return '';
  return panel('Event types','Pageviews and explicit app events only.',
    table(['Event','Count','Conversions'],rows.map(r => [cell(r.event_name),cell(num(r.events),true),cell(num(r.conversions),true)])));
}

function overview() {
  const project = selection();
  return (project ? pageHead(escape(project.name), escape(domain(project.url)), link('projects','To the registry')) : state.mode === 'live' ? pageHead('Overview','Visitors, pageviews, and activity of the selected sites.') : hero())
    + controls() + dataError() + (project ? reportTabs() : '') + kpis()
    + `<div class="analytics-grid">${panel(state.mode === 'live' ? 'Pageviews per day' : 'Events per day',state.mode === 'live' ? 'Pageviews · previous period dashed' : 'All events of the selected projects',chart(),'<div class="control-group"><span class="key">Current</span><span class="key prev">Previous</span></div>')}
      ${panel('Conversion channels',state.model === 'first' ? 'First touch in the period' : 'Last touch before the goal',channels(),link('attribution','Breakdown'))}</div>`
    + (state.mode === 'live' ? pagesPanel() : '')
    + dashboardGrid()
    + panel(project ? 'Project data' : 'OpenMVP Stat', project ? 'Summary of the selected project' : 'Network registry · projects, event flow, and CRM links', projectTable(state.snapshot.projects), `<a class="button" href="${projectHref('projects')}">All projects ↗</a>`)
    + modules();
}

function dataError() {
  if (state.busy) return callout('Refreshing ClickHouse data…');
  return state.error ? callout('ClickHouse is temporarily unavailable. Check the connection and retry. ' + button('retry','Retry'),true) : '';
}

function tagBar() {
  const counts = {};
  state.snapshot.projects.forEach(row => (row.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; }));
  const tags = Object.keys(counts).sort((a,b) => a.localeCompare(b,'ru'));
  if (!tags.length) return '';
  const chip = (tag, label, count) => `<button class="chip${(state.tag || '') === tag ? ' active' : ''}" type="button" data-action="tag" data-tag="${escape(tag)}">${escape(label)}<span>${count}</span></button>`;
  return `<div class="tag-bar" role="group" aria-label="Tag filter">${chip('', 'All', state.snapshot.projects.length)}${tags.map(tag => chip(tag, tag, counts[tag])).join('')}</div>`;
}

function tagSummary() {
  const rows = state.snapshot.projects;
  const cards = [
    ['Visitors', num(total(rows,'visitors')), 'Unique visitors across sites tagged "' + escape(state.tag) + '"', 'users'],
    ['Pageviews', num(total(rows,'pageviews')), 'Pageviews in the period', 'pulse'],
    ['Humans · likely', num(total(rows,'human_visitors')), 'By browser User-Agent', 'target'],
    ['Bots', num(total(rows,'bot_visitors')), 'UA matched a bot signature', 'layers'],
  ];
  return `<div class="kpis section-gap">${cards.map(([title,value,note,glyph]) => `<div class="kpi"><div class="kpi-top"><span>${title}</span>${icon(glyph)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`).join('')}</div>`;
}

function tagHourly() {
  const data = state.snapshot.hourly || [];
  if (!data.some(point => point.visitors)) return '';
  const top = Math.max(1, ...data.map(point => point.visitors));
  const cols = data.map(point => `<div class="hour-col"><i style="height:${Math.round(100 * point.visitors / top)}%" title="${point.hour}:00 UTC — ${num(point.visitors)}"></i><span>${point.hour}</span></div>`).join('');
  return panel('Visitors by hour','Unique visitors by hour of day (UTC) within the selected period.',`<div class="hourly">${cols}</div>`);
}

function projectPage() {
  const tagView = state.tag ? tagSummary() + tagHourly() : '';
  return pageHead('OpenMVP Stat','Site registry: pageviews, visitors, traffic type, and results per project.',button('add','New project','plus','primary'))
    + controls() + dataError() + tagBar() + tagView + panel('Project registry','The built-in catalog can be extended with your own projects. The Tags button in a row assigns tags to a site.',
      '<div id="project-table">' + projectTable(filteredProjects()) + '</div>',
      `<input id="project-filter" type="search" aria-label="Search project" placeholder="Project or domain" value="${escape(state.search)}">`);
}
function filteredProjects() {
  const query = state.search.trim().toLocaleLowerCase('ru');
  return state.snapshot.projects
    .filter(row => [row.name,row.url,row.id].some(value => String(value || '').toLocaleLowerCase('ru').includes(query)))
    .filter(row => !state.tag || (row.tags || []).includes(state.tag));
}

function eventPage() {
  return pageHead('Events','Browse the most recent events received across projects and sessions.') + controls() + dataError()
    + panel('Event log','One logical page_view record per page; extra events only via explicit calls.',table(['Time UTC','Project','Event','Page','Session','Channel','Traffic type','Country','Duration','Depth'],state.snapshot.events.map(row => [
      cell(row.timestamp),cell(projects.find(p => p.id === row.project_id)?.name || row.project_id),
      `<td><code>${escape(row.event_name)}</code></td>`,cell(row.page || '—'),cell(row.session_id),cell(channelName(row.channel)),
      cell(trafficLabel(row.traffic_type)),cell(countryLabel(row.country_code)),
      cell(row.duration_ms ? (Number(row.duration_ms) / 1000).toFixed(1) + ' s' : '—'),cell(row.scroll_depth ? num(row.scroll_depth) + '%' : '—'),
    ])));
}

function attributionPage() {
  const choice = '<select id="model-select" aria-label="Attribution model"><option value="last">Last touch</option><option value="first">First touch</option></select>';
  return pageHead('Attribution','Compare channels by first and last touch. CRM deals are linked to a conversion by the shared client identifier.',choice)
    + controls() + dataError() + panel('Channels and CRM','Touches are searched within the selected period up to the goal moment. Revenue is the sum of linked deals in USD.',table(['Channel','Conversions','With CRM','Revenue, USD'],state.snapshot.attribution.map(row => [
      cell(channelName(row.channel)),cell(num(row.conversions),true),cell(num(row.linked),true),cell(num(row.revenue),true),
    ])));
}

function featuresPage() {
  return pageHead('Behavior','Break the event stream down into session and visitor metrics.') + controls() + dataError()
    + panel('Feature dictionary','A cut across the selected projects and period.',table(['Feature','Value','Definition'],state.snapshot.features.map(row => [cell(row.feature),cell(num(row.value),true),cell(row.definition)])));
}

const prompts = {
  summary: 'Build a summary of pageviews, visitors, likely humans/bots, and countries. Compare pageviews with the previous period and name the site with the most visitors.',
  crm: 'Compare channels by first and last touch. Show conversions, CRM linkage, and revenue per channel. State the period.',
  behavior: 'Show time and depth per page, engaged and returning sessions, and the human/bot/unknown traffic split. Explain the definitions and limits of UA classification.',
};
function reportText() {
  const s = state.snapshot;
  const lead = [...s.projects].sort((a,b) => Number(b.conversions)-Number(a.conversions))[0];
  const events = total(s.daily, state.mode === 'live' ? 'pageviews' : 'events');
  const before = total(s.previous, state.mode === 'live' ? 'pageviews' : 'events');
  const metricLabel = state.mode === 'live' ? 'Pageviews' : 'Events';
  const topCountries = (s.countries || []).slice(0,5).map(row => countryLabel(row.country_code) + ': ' + num(row.visitors)).join(', ') || 'no data';
  const base = ['VibeMetrics · ' + (selection()?.name || 'All projects'), dateRange() + ' · ' + (state.mode === 'live' ? 'ClickHouse' : 'Demo data'), ''];
  const contents = {
    summary: state.mode === 'live' ? [
      metricLabel + ': ' + num(events), metricLabel + ' in the previous period: ' + num(before),
      'Visitors across sites: ' + num(total(s.projects,'visitors')),
      'Humans · likely: ' + num(total(s.projects,'human_visitors')) + ' · bots: ' + num(total(s.projects,'bot_visitors')),
      'Top countries: ' + topCountries,
      'Conversions: ' + num(total(s.projects,'conversions')),
      'Conversions leader: ' + (lead?.conversions ? lead.name + ' · ' + num(lead.conversions) : 'no data'),
    ] : [
      'Events: ' + num(events), 'Events in the previous period: ' + num(before),
      'Sessions: ' + num(total(s.projects,'sessions')), 'Conversions: ' + num(total(s.projects,'conversions')),
      'Conversions leader: ' + (lead?.conversions ? lead.name + ' · ' + num(lead.conversions) : 'no data'),
    ],
    crm: ['Model: ' + (state.model === 'first' ? 'first touch' : 'last touch'), ...s.attribution.map(row => channelName(row.channel) + ' · conversions ' + num(row.conversions) + ' · with CRM ' + num(row.linked) + ' · USD ' + num(row.revenue))],
    behavior: s.features.map(row => row.feature + ' · ' + num(row.value) + ' · ' + row.definition),
  };
  return base.concat(contents[state.report].length ? contents[state.report] : ['No data for the period.']).join('\n');
}

const standardReports = [
  { id:'traffic', title:'Visitors and pageviews', detail:'Visitor type is taken from the last page_view of the period; User-Agent classification is heuristic, not absolute.', render:s => table(['Traffic type','Visitors','Pageviews'],(s.traffic||[]).map(r => [cell(trafficLabel(r.traffic_type)),cell(num(r.visitors),true),cell(num(r.pageviews),true)]),'No page_view in the period.') },
  { id:'countries', title:'Countries', detail:'Country of the visitor last page_view in the period; GeoIP is approximate, the IP is not stored in ClickHouse.', render:s => table(['Country','Code','Visitors','Pageviews'],(s.countries||[]).map(r => [cell(countryLabel(r.country_code)),cell(r.country_code),cell(num(r.visitors),true),cell(num(r.pageviews),true)]),'No geo data.') },
  { id:'pages', title:'Pages', detail:'Popularity and engagement by page path.', render:s => table(['Page','Pageviews','Visitors','Avg time','Depth'],(s.pages||[]).map(r => [cell(r.page),cell(num(r.views),true),cell(num(r.visitors),true),cell(r.avg_time_seconds ? num(r.avg_time_seconds)+' s' : '—'),cell(r.avg_scroll_depth ? num(r.avg_scroll_depth)+'%' : '—')]),'No pages yet.') },
  { id:'sources', title:'Sources and CRM', detail:'Channels, goal actions, and linked deals.', render:s => table(['Channel','Conversions','With CRM','Revenue, USD'],(s.attribution||[]).map(r => [cell(channelName(r.channel)),cell(num(r.conversions),true),cell(num(r.linked),true),cell(num(r.revenue),true)]),'No conversions yet.') },
  { id:'events', title:'Event types', detail:'Only pageviews and events explicitly sent by the app.', render:s => table(['Event','Count','Conversions'],(s.top_events||[]).map(r => [cell(r.event_name),cell(num(r.events),true),cell(num(r.conversions),true)]),'No events yet.') },
  { id:'goals', title:'Goals', detail:'Goal event names configured via JS; names match exactly and each goal becomes a conversion.', render:s => table(['Event name','Count','Sessions'],goalRows().map(r => [cell(r.event_name),cell(num(r.events),true),cell(num(r.sessions),true)]),'No goals yet.') },
];

function reportsPage() {
  const selected = standardReports.find(r => r.id === state.standardReport) || standardReports[0];
  const standardSelect = `<select id="standard-report-select" aria-label="Standard report">${standardReports.map(r => `<option value="${r.id}"${r.id === selected.id ? ' selected' : ''}>${r.title}</option>`).join('')}</select>`;
  const standardPanel = state.mode === 'live' ? panel(selected.title,selected.detail,selected.render(state.snapshot),standardSelect) : '';
  const options = '<select id="report-select" aria-label="Report template"><option value="summary">Network summary</option><option value="crm">Attribution and CRM</option><option value="behavior">Behavior</option></select>';
  const context = 'Project: ' + (selection()?.name || 'the whole network') + '. Period: ' + state.days + ' days. ';
  return pageHead('Reports','Standard reports of the selected project and an extensible catalog.')
    + controls() + dataError() + standardPanel
    + panel('Prompt for the AI agent','A ready-made prompt for your MCP client, scoped to the current project and period.',`<div class="detail"><p id="agent-prompt">${escape(context + prompts[state.report])}</p><div class="control-group section-gap">${button('copy','Copy prompt','file')}${button('report','Build summary','terminal','primary')}</div></div>`,options)
    + (state.reportReady ? panel('Data summary','Result of the selected template.',`<pre class="code-block">${escape(reportText())}</pre>`,button('report-download','Download TXT','download')) : '');
}

function sourcesPage() {
  const host = state.mode === 'live' ? 'API connected. Events and aggregates are read from your ClickHouse.' : 'This instance serves a demo dataset. The bundle ships the API and Compose to connect your own data.';
  return pageHead('Data sources','The pipeline for sites, apps, and CRM inside your own infrastructure.',state.mode === 'demo' ? `<a class="button primary" href="./downloads/vibemetrics-self-hosted.zip" download>${icon('download')} Download the self-hosted bundle</a>` : '')
    + callout(host)
    + panel('Setup order','ClickHouse stores events, touches, and CRM identifiers.',`<ol class="steps">
      <li><strong>Deploy the stack.</strong> Unpack the archive, create <code>.env</code> from the example, and start Docker Compose.</li>
      <li><strong>Add a project.</strong> Set a stable ID in OpenMVP Stat. It is used across the API and MCP.</li>
      <li><strong>Wire the site.</strong> Paste the <code>&lt;script ... /tracker.js&gt;</code> snippet; it writes one logical <code>page_view</code> per page, updating time/depth on the same ID. Extra events only via explicit calls.</li>
      <li><strong>Send server-side events.</strong> For backend integration use <code>POST /api/events</code>.</li>
      <li><strong>Link the CRM.</strong> Send deals to <code>POST /api/crm</code> with the same <code>person_id</code> as the project events.</li>
    </ol><pre class="code-block">cp .env.example .env
# Fill .env with your values
docker compose up --build -d</pre>`)
    + panel('Event contract','Use stable session, client, and event identifiers.',`<pre class="code-block">{
  "project_id": "tapapp",
  "event_id": "checkout-0027",
  "session_id": "session-118",
  "person_id": "customer-315",
  "event_name": "purchase",
  "channel": "Paid search",
  "page": "/checkout",
  "is_conversion": true
}</pre>`);
}

function exportsPage() {
  return pageHead('Exports and MCP','Download the selected project data or hook an MCP agent to it.') + controls() + dataError()
    + `<div class="modules">${[
      ['download','Projects · CSV','Events, sessions, conversions, and CRM per project.','csv','Download CSV'],
      ['file','Snapshot · JSON','Projects, daily series, attribution, features, and recent events.','json','Download JSON'],
      ['route','Attribution · CSV','Channel, conversion count, CRM linkage, and revenue per selected model.','attr-csv','Download CSV'],
    ].map(([glyph,title,copy,action,label]) => `<section class="panel module">${icon(glyph)}<h2>${title}</h2><p>${copy}</p>${button(action,label,'download')}</section>`).join('')}</div>`
    + `<div class="section-gap">${panel('MCP hookup','The local stdio server from the self-hosted bundle. Read-only access.',`<pre class="code-block">python3 selfhost/mcp_server.py</pre><div class="detail"><p><code>list_projects</code> · <code>get_snapshot</code> · <code>export_csv</code></p><p>For the client config use the absolute file path and the <code>VM_API_URL</code>, <code>VM_READ_TOKEN</code> variables.</p></div>`,link('sources','Deployment'))}</div>`;
}

function mcpPage() {
  const skills = [
    ['vibemetrics-analytics','Project summary','Compare events and sessions across projects and periods.'],
    ['vibemetrics-attribution','Attribution','Analyze first/last touch, conversions, and linked CRM deals.'],
    ['vibemetrics-behavior','Behavior','Interpret the available feature metrics and recent events.'],
  ];
  const skillCards = skills.map(([id,title,copy]) => `<section class="panel module"><h2>${title}</h2><p>${copy}</p><a class="text-link" href="/skills/${id}/SKILL.md" download>Download SKILL.md ↗</a></section>`).join('');
  const config = JSON.stringify({mcpServers:{vibemetrics:{command:'python3',args:['/opt/vibemetrics/selfhost/mcp_server.py'],env:{VM_API_URL:'http://127.0.0.1:18080',VM_READ_TOKEN:'<read-token>'}}}},null,2);
  return pageHead('MCP for agents','Plug VibeMetrics into an MCP client and read analytics through standard tools.','<a class="button" href="/docs/mcp.html">Documentation ↗</a>')
    + callout('Read-only MCP · stdio transport · data access requires VM_READ_TOKEN.')
    + panel('MCP tools','Cuts are limited to the available projects and periods.',table(['Tool','Purpose','Parameters'],[
      [cell('list_projects'),cell('Projects and their stable IDs.'),cell('no parameters')],
      [cell('get_snapshot'),cell('Totals, daily series, attribution, features, and recent events.'),cell('project · days · model')],
      [cell('export_csv'),cell('Export a snapshot slice as CSV text.'),cell('dataset · project · days · model')],
    ]))
    + panel('MCP client setup','Example for a local stdio process. Take the read token from the server configuration.',`<pre class="code-block">${escape(config)}</pre><div class="detail"><p><a class="text-link" href="/docs/mcp.html">Full setup guide ↗</a></p><p>Attribution models: first and last. Periods: 7, 14, or 30 days.</p></div>`)
    + panel('Agent skills','Ready-made instructions for typical VibeMetrics queries.',`<div class="modules">${skillCards}</div>`);
}

function reportTabs() {
  if (!state.project) return '';
  const tabs = [
    ['overview','Overview',''], ['events','Events',''], ['attribution','Attribution',''],
    ['features','Behavior',''], ['goals','Goals',''], ['reports','Traffic','traffic'],
    ['reports','Countries','countries'], ['reports','Pages','pages'],
    ['reports','Sources','sources'], ['reports','Event types','events'],
  ];
  return `<div class="tag-bar section-gap" aria-label="Project reports">${tabs.map(([page,label,report]) => {
    const active = route().page === page && (!report || state.standardReport === report);
    return `<a class="chip${active ? ' active' : ''}" href="${projectHref(page, state.project, state.tag, report ? { report } : {})}">${label}</a>`;
  }).join('')}</div>`;
}

function goalRows() {
  const events = state.snapshot.goal_events || [];
  const known = new Set(events.map(row => row.event_name));
  const builtin = [
    { event_name:'Goal1', events:state.snapshot.goals?.goal1 || 0, sessions:0, last_seen:'' },
    { event_name:'Goal2', events:state.snapshot.goals?.goal2 || 0, sessions:0, last_seen:'' },
  ].filter(row => !known.has(row.event_name));
  return [...builtin, ...events];
}

function goalsPage() {
  const rows = goalRows();
  const tableRows = rows.map(row => [cell(row.event_name),cell(num(row.events),true),cell(num(row.sessions),true),cell(row.last_seen ? fmtDate(row.last_seen) : '—')]);
  const stats = panel('Goal events','Names and counts of all goal events in the selected period.',
    table(['Event name','Count','Sessions','Last seen'],tableRows,'No goals yet. Call window.vibeGoal(name) on the site.'));
  const snippet = `<pre class="code-block">window.vibeGoal('Goal1', { place: 'pricing' });
window.vibeGoal('Goal2', { place: 'thank-you' });
window.vibeGoal('purchase', { plan: 'pro' });</pre>`;
  const setup = isPanel()
    ? panel('Goal setup and postbacks','Goal names are matched exactly; every matching event becomes a conversion. A goal with clid triggers a POST to the postback URL.',
        `<form id="goals-form" class="detail">
          <label>Project<select id="goals-project-select" aria-label="Project for goal setup">${projects.map(p => `<option value="${escape(p.id)}"${p.id === state.project ? ' selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label>
          <label>Goal event names <span>(comma-separated, up to 50)</span><input id="goals-input" maxlength="2000" placeholder="Goal1, Goal2, purchase"></label>
          <label>Postback URL <span>(optional, http(s))</span><input id="goals-url" maxlength="500" placeholder="https://site.com/vm-postback"></label>
          <p class="form-error" id="goals-status" role="alert"></p>
          <div class="control-group section-gap">${button('goal-save','Save goals and postback','target','primary')}</div>
        </form>`)
    : panel('Goal setup','Sign in to the admin panel to edit goal names and postback URLs.','<div class="detail"><a class="button" href="/panel/goals">Open /panel/goals ↗</a></div>');
  return pageHead('Goals','Goal event names, counts and postback configuration.')
    + controls() + dataError()
    + (state.project ? reportTabs() : '')
    + stats + setup
    + panel('JS API','Send goals from the site with the tracker snippet.',snippet);
}

const renderers = { overview, projects:projectPage, events:eventPage, attribution:attributionPage, features:featuresPage, reports:reportsPage, sources:sourcesPage, exports:exportsPage, mcp:mcpPage, goals:goalsPage };
async function loadGoalConfig() {
  state.goalConfigLoaded = true;
  if (!isPanel() || state.mode !== 'live') return;
  try {
    state.goalConfig = await request('projects/goals');
    fillGoalForm();
  } catch (error) { state.goalConfigError = error.message; }
}
function fillGoalForm() {
  const id = $('#goals-project-select')?.value || state.project;
  const config = (state.goalConfig || []).find(item => item.id === id) || { goals:[], postback_url:'' };
  if ($('#goals-input')) $('#goals-input').value = config.goals.join(', ');
  if ($('#goals-url')) $('#goals-url').value = config.postback_url || '';
  if ($('#goals-status')) $('#goals-status').textContent = '';
}
function render() {
  const page = route().page;
  if (page === 'goals' && !state.goalConfigLoaded) loadGoalConfig();
  $('#crumb').textContent = views[page];
  $('#nav-count').textContent = projects.length;
  $('#engine-status').textContent = state.error ? 'Connection lost' : state.mode === 'live' ? 'Own pipeline connected' : 'Demo pipeline';
  document.querySelectorAll('.side-nav [data-view], [data-top]').forEach(a => {
    const target = a.dataset.view || a.dataset.top;
    const selected = target === page;
    if (target) a.href = projectHref(target, target === 'projects' ? '' : state.project, state.tag);
    if (selected) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
  });
  $('.mast-actions .bundle').hidden = state.mode === 'live';
  $('.brand').href = projectHref('overview','',state.tag);
  viewNode.innerHTML = renderers[page]();
  if ($('#model-select')) $('#model-select').value = state.model;
  if ($('#report-select')) $('#report-select').value = state.report;
  if ($('#standard-report-select')) $('#standard-report-select').value = state.standardReport;
  if (page === 'goals' && isPanel() && state.goalConfig) fillGoalForm();
  mountIcons(document);
}

async function request(path, options) {
  const response = await fetch('./api/' + path, { ...options, headers:{ Accept:'application/json', ...options?.headers } });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API unavailable');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'API error');
  return result;
}
function emptySnapshot() {
  return { projects:projects.filter(p => !state.project || p.id === state.project), daily:[], previous:[], events:[], attribution:[], features:[], pages:[], traffic:[], countries:[], top_events:[], hourly:[], goal_events:[], goals:{goal1:0,goal2:0} };
}
async function refresh() {
  const number = ++requestNumber;
  state.reportReady = false;
  if (state.mode === 'demo') {
    state.snapshot = demoSnapshot(projects,state.project,state.days,state.model);
    render();
    return;
  }
  state.snapshot = emptySnapshot();
  state.busy = true;
  state.error = '';
  render();
  try {
    const data = await request('snapshot?' + new URLSearchParams({ project:state.project, days:state.days, offset:state.offset, model:state.model, tag:state.tag }));
    if (number !== requestNumber) return;
    state.snapshot = data;
  } catch (error) {
    if (number !== requestNumber) return;
    state.error = error.message;
  } finally {
    if (number === requestNumber) { state.busy = false; render(); }
  }
}
function followRoute() {
  const current = route();
  state.project = projects.some(p => p.id === current.project) ? current.project : '';
  state.tag = current.tag || '';
  if (current.report && standardReports.some(r => r.id === current.report)) state.standardReport = current.report;
  refresh();
}
function navigate(url, replace = false) {
  if (replace) history.replaceState({}, '', url); else history.pushState({}, '', url);
  followRoute();
}
function migrateHash() {
  if (!location.hash || location.hash === '#') return;
  const [fragment, query = ''] = location.hash.slice(1).split('?');
  const page = ({ ai:'reports' })[fragment] || fragment;
  if (!Object.hasOwn(views, page)) { history.replaceState({}, '', base); return; }
  const params = new URLSearchParams(query);
  history.replaceState({}, '', projectHref(page, params.get('project') || '', params.get('tag') || ''));
}
window.addEventListener('popstate',followRoute);
window.addEventListener('hashchange',followRoute);
document.addEventListener('click',event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest('a[href]');
  if (!anchor || anchor.target || anchor.download) return;
  const url = new URL(anchor.href);
  if (url.host !== location.host || !url.pathname.startsWith(base)) return;
  const target = url.pathname + url.search;
  if (target === location.pathname + location.search) return;
  event.preventDefault();
  navigate(target);
});
$('.skip').addEventListener('click', event => { event.preventDefault(); $('#content').focus(); });

function notify(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  toastTimer = setTimeout(() => { $('#toast').textContent = ''; },2500);
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify('File ready');
}
function csvValue(value) {
  const text = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+@-]/.test(text) && typeof value !== 'number' ? "'" + text : text;
  return '"' + safe.replaceAll('"','""') + '"';
}
function csv(kind) {
  const headers = kind === 'attribution' ? ['channel','conversions','linked','revenue'] : ['id','name','events','sessions','conversions','linked','revenue'];
  const rows = kind === 'attribution' ? state.snapshot.attribution : state.snapshot.projects;
  return '\uFEFF' + [headers.join(','), ...rows.map(row => headers.map(key => csvValue(row[key] ?? 0)).join(','))].join('\r\n');
}
viewNode.addEventListener('click', async event => {
  const trigger = event.target.closest('[data-action]');
  const action = trigger?.dataset.action;
  const suffix = (state.project || 'network') + '-' + state.days + 'd';
  if (action === 'add') { $('#project-form').reset(); $('#form-error').textContent = ''; $('#project-dialog').showModal(); }
  if (action === 'retry') refresh();
  if (action === 'tag') navigate(projectHref('projects', state.project, trigger.dataset.tag || ''));
  if (action === 'tags') {
    const project = projects.find(item => item.id === trigger.dataset.id);
    if (!project) return;
    $('#tags-form').dataset.id = project.id;
    $('#tags-project').textContent = project.name + ' · ' + domain(project.url);
    $('#tags-input').value = (project.tags || []).join(', ');
    $('#tags-error').textContent = '';
    $('#tags-dialog').showModal();
  }
  if (['csv','attr-csv','json','report','report-download'].includes(action) && (state.busy || state.error)) { notify('Wait for the data to load'); return; }
  if (action === 'csv') download('vibemetrics-' + suffix + '.csv',csv('projects'),'text/csv;charset=utf-8');
  if (action === 'attr-csv') download('vibemetrics-attribution-' + state.model + '-' + suffix + '.csv',csv('attribution'),'text/csv;charset=utf-8');
  if (action === 'json') download('vibemetrics-' + suffix + '.json',JSON.stringify({ mode:state.mode, model:state.model, days:state.days, ...state.snapshot },null,2),'application/json');
  if (action === 'report-download') download('vibemetrics-report-' + suffix + '.txt',reportText(),'text/plain;charset=utf-8');
  if (action === 'report') { state.reportReady = true; render(); $('.code-block')?.scrollIntoView({ block:'nearest' }); }
  if (action === 'goal-save') {
    const id = $('#goals-project-select')?.value;
    const goals = parseGoals($('#goals-input')?.value || '');
    const postback_url = ($('#goals-url')?.value || '').trim();
    const status = $('#goals-status');
    if (!id || !goals.length) { status.textContent = 'Specify a project and at least one goal name'; return; }
    try {
      await request('projects/goals',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id, goals, postback_url }) });
      state.goalConfig = (state.goalConfig || []).map(item => item.id === id ? { id, goals, postback_url } : item);
      if (!state.goalConfig.some(item => item.id === id)) state.goalConfig.push({ id, goals, postback_url });
      status.textContent = '';
      notify('Goals saved');
    } catch (error) { status.textContent = error.message; }
  }
  if (action === 'copy') {
    const text = $('#agent-prompt').textContent;
    try { await navigator.clipboard.writeText(text); notify('Prompt copied'); }
    catch { const range = document.createRange(); range.selectNodeContents($('#agent-prompt')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); notify('Prompt selected for copying'); }
  }
});
viewNode.addEventListener('change',event => {
  const { id, value } = event.target;
  if (id === 'project-select') navigate(projectHref(route().page,value,state.tag));
  if (id === 'period-select') {
    state.period = value;
    const preset = { today:[1,0], yesterday:[1,1], 7:[7,0], 14:[14,0], 30:[30,0] }[value] || [7,0];
    [state.days, state.offset] = preset;
    refresh();
  }
  if (id === 'goals-project-select') fillGoalForm();
  if (id === 'model-select') { state.model = value; refresh(); }
  if (id === 'report-select') { state.report = value; state.reportReady = false; render(); $('#report-select').focus(); }
  if (id === 'standard-report-select') { state.standardReport = value; navigate(projectHref('reports', state.project, state.tag, { report: value }), true); $('#standard-report-select').focus(); }
});
viewNode.addEventListener('input',event => {
  if (event.target.id !== 'project-filter') return;
  state.search = event.target.value;
  $('#project-table').innerHTML = projectTable(filteredProjects());
});
$('#project-dialog').addEventListener('click',event => {
  if (event.target.closest('[data-action="close"]')) $('#project-dialog').close();
});
$('#tags-dialog').addEventListener('click',event => {
  if (event.target.closest('[data-action="close"]')) $('#tags-dialog').close();
});
$('#tags-form').addEventListener('submit',async event => {
  event.preventDefault();
  const project = projects.find(item => item.id === event.currentTarget.dataset.id);
  if (!project) { $('#tags-dialog').close(); return; }
  const tags = parseTags($('#tags-input').value);
  const submit = event.currentTarget.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    if (state.mode === 'live') {
      await request('projects/tags',{ method:'POST', headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ id:project.id, tags }) });
    } else {
      const updated = JSON.parse(localStorage.getItem('vibemetrics.projects') || '[]').map(item => item.id === project.id ? { ...item, tags } : item);
      localStorage.setItem('vibemetrics.projects', JSON.stringify(updated));
      projects = [...catalog, ...updated];
    }
    project.tags = tags;
    $('#tags-dialog').close();
    notify('Tags saved');
    refresh();
  } catch (error) { $('#tags-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#project-form').addEventListener('submit',async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  const data = Object.fromEntries(Array.from(new FormData(form),([key,value]) => [key,value.trim()]));
  if (!data.name || !/^[a-z][a-z0-9-]{0,47}$/.test(data.id)) { $('#form-error').textContent = 'Provide a name and a valid project ID.'; return; }
  if (projects.some(p => p.id === data.id)) { $('#form-error').textContent = 'A project with this ID already exists.'; return; }
  if (!data.url || !safeUrl(data.url)) { $('#form-error').textContent = 'Provide a valid HTTPS domain for the project.'; return; }
  data.url = safeUrl(data.url);
  data.tags = parseTags(data.tags);
  submit.disabled = true;
  let trackerSnippet = '';
  try {
    if (state.mode === 'live') {
      const created = await request('projects',{ method:'POST', headers:{ 'Content-Type':'application/json' },body:JSON.stringify(data) });
      trackerSnippet = created.snippet || '';
      projects = [...projects,created];
    } else {
      const updated = [...demoProjects(),data];
      localStorage.setItem('vibemetrics.projects', JSON.stringify(updated.slice(catalog.length)));
      projects = updated;
    }
    $('#project-dialog').close();
    if (trackerSnippet) {
      try { await navigator.clipboard.writeText(trackerSnippet); notify('Project added. Tracker snippet copied.'); }
      catch { window.prompt('Copy the tracker snippet and paste it into the site:', trackerSnippet); }
    } else notify('Project added');
    if (state.project) location.hash = '#projects';
    else refresh();
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { submit.disabled = false; }
});

migrateHash();
state.mode = 'live';
state.busy = true;
projects = [];
state.project = route().project;
state.snapshot = emptySnapshot();
render();
request('status').then(async status => {
  if (status.mode !== 'live') throw new Error('Live API unavailable');
  projects = await request('projects');
  state.busy = false;
  followRoute();
}).catch(() => {
  // No API nearby (local demo stand or backend down) — fall back to the demo pipeline.
  state.mode = 'demo';
  state.busy = false;
  state.error = '';
  projects = demoProjects();
  state.snapshot = emptySnapshot();
  followRoute();
});
