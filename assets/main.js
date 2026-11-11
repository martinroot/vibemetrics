import catalog from './projects.js';
import { demoSnapshot, total } from './demo.js';
import { icon, mountIcons } from './icons.js';

const $ = selector => document.querySelector(selector);
const views = { overview:'Обзор', projects:'OpenMVP Stat', events:'События', attribution:'Атрибуция', features:'Поведение', reports:'Отчёты', sources:'Источники', exports:'Выгрузки', mcp:'MCP для агентов' };
const state = { mode:'demo', project:'', tag:'', days:1, offset:0, period:'today', model:'last', report:'summary', standardReport:'traffic', reportReady:false, search:'', snapshot:null, error:'', busy:false };
const numbers = new Intl.NumberFormat('ru-RU');
const compact = new Intl.NumberFormat('ru-RU', { notation:'compact', maximumFractionDigits:1 });
const dateLabel = new Intl.DateTimeFormat('ru-RU', { day:'numeric', month:'short', timeZone:'UTC' });
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const num = value => numbers.format(Number(value || 0));
const countryNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['ru'], { type:'region' }) : null;
const countryLabel = code => {
  if (!code || code === 'ZZ') return 'Не определена';
  try { return countryNames?.of(code) || code; } catch { return code; }
};
const trafficLabel = value => ({ human:'Люди · вероятно', bot:'Бот', unknown:'Неизвестно' })[value] || 'Неизвестно';
const names = { 'Organic search':'Органический поиск', 'Paid search':'Платный поиск', Direct:'Прямые заходы', 'Partner referral':'Партнёрские ссылки' };
const channelName = channel => names[channel] || channel || 'Прямые заходы';
const fmtDate = value => dateLabel.format(new Date(value));
const safeUrl = value => {
  if (!value) return '';
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
const domain = url => { const valid = safeUrl(url); return valid ? new URL(valid).hostname : 'Без домена'; };
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
const table = (head, rows, empty = 'За этот период данных пока нет.') => `<div class="table-wrap"><table><thead><tr>${head.map(title => {
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
const mode = () => `<span class="mode${state.error ? ' warn' : ''}"><i class="status-dot"></i>${state.error ? 'Нет соединения' : state.mode === 'live' ? 'Данные ClickHouse' : 'Демо-данные'}</span>`;

function controls() {
  return `<div class="tools-row"><div class="control-group">${mode()}<span class="quiet">${dateRange()}</span></div><div class="control-group">
    <select id="project-select" aria-label="Проект"><option value="">Все проекты</option>${projects.map(p => `<option value="${escape(p.id)}"${p.id === state.project ? ' selected' : ''}>${escape(p.name)}</option>`).join('')}</select>
    <select id="period-select" aria-label="Период">${[['today','Сегодня'],['yesterday','Вчера'],[7,'7 дней'],[14,'14 дней'],[30,'30 дней']].map(([value,label]) => `<option value="${value}"${String(value) === String(state.period) ? ' selected' : ''}>${label}</option>`).join('')}</select>
    ${button('csv','Скачать CSV','download')}
  </div></div>`;
}

function hero() {
  const steps = [['pulse','События'],['database','ClickHouse'],['link','CRM'],['terminal','MCP / AI']];
  return `<section class="hero"><div><span class="eyebrow">IN-HOUSE PRODUCT ANALYTICS</span><h1>Вся сеть в цифрах.</h1><p>Собирайте события в своём ClickHouse, связывайте визиты со сделками в CRM и отдавайте агентам данные для отчётов через MCP.</p></div>
    <div class="flow" aria-label="События, ClickHouse, CRM и MCP">${steps.map(([glyph, label]) => `<div class="flow-step">${icon(glyph)}${label}</div>`).join('<span class="flow-arrow" aria-hidden="true">→</span>')}</div></section>`;
}

function kpis() {
  const list = state.snapshot.projects;
  const cards = state.mode === 'live' ? [
    ['Просмотры', num(total(list,'pageviews')), 'Одна запись на страницу; обновляется по выходу', 'pulse'],
    ['Посетители', num(total(list,'visitors')), 'Сумма уникальных по выбранным сайтам', 'users'],
    ['Люди · вероятно', num(total(list,'human_visitors')), 'По User-Agent браузера', 'target'],
    ['Боты', num(total(list,'bot_visitors')), 'UA совпал с известной bot-сигнатурой', 'layers'],
  ] : [
    ['События', num(total(list,'events')), 'Действия на сайтах и в приложениях', 'pulse'],
    ['Сессии', num(total(list,'sessions')), 'Сессии внутри проектов', 'users'],
    ['Конверсии', num(total(list,'conversions')), 'Целевые события за период', 'target'],
    ['Связано с CRM', total(list,'conversions') ? Math.round(100 * total(list,'linked') / total(list,'conversions')) + '%' : '—', num(total(list,'linked')) + ' конверсий с CRM-сделкой', 'link'],
  ];
  return `<div class="kpis">${cards.map(([title,value,note,glyph]) => `<div class="kpi"><div class="kpi-top"><span>${title}</span>${icon(glyph)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`).join('')}</div>`;
}

function chart() {
  const { daily, previous } = state.snapshot;
  const metric = state.mode === 'live' ? 'pageviews' : 'events';
  const unit = state.mode === 'live' ? 'просмотров' : 'событий';
  const value = point => Number(point[metric] || 0);
  if (!daily.some(point => value(point)) && !previous.some(point => value(point))) return `<p class="empty">${state.mode === 'live' ? 'Просмотров пока нет.' : 'Событий пока нет. Выберите другой проект или период.'}</p>`;
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
  return `<div class="chart"><svg viewBox="0 0 625 178" role="img" aria-label="${state.mode === 'live' ? 'Просмотры' : 'События'} по дням с предыдущим периодом">
    <defs><linearGradient id="volume-fill" x1="0" x2="0" y1="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#91c8ae" stop-opacity=".49"/><stop offset="1" stop-color="#e0f1e9" stop-opacity=".17"/></linearGradient></defs>
    ${guides.join('')}<polygon points="${area}" fill="url(#volume-fill)"/><polyline points="${line(points(previous))}" class="compare"/><polyline points="${line(coords)}" class="series"/>
    ${coords.map(([x,y],i) => `<circle cx="${x}" cy="${y}" r="3" fill="#267f68"><title>${fmtDate(daily[i].date)} · ${num(value(daily[i]))} ${unit}</title></circle>`).join('')}${labels.join('')}</svg></div>`;
}

function channels() {
  const rows = state.snapshot.attribution.slice(0,5);
  const count = total(state.snapshot.attribution,'conversions');
  if (!count) return '<p class="empty">Конверсий пока нет.</p>';
  return `<div class="channel-list">${rows.map(row => {
    const percent = Math.round(100 * row.conversions / count);
    return `<div class="channel"><strong>${escape(channelName(row.channel))}</strong><b>${percent}%</b><div class="track"><i style="width:${percent}%"></i></div></div>`;
  }).join('')}</div>`;
}

function projectTable(rows) {
  const live = state.mode === 'live';
  const ranked = [...rows].sort((a,b) => Number(live ? b.pageviews : b.events) - Number(live ? a.pageviews : a.events) || a.name.localeCompare(b.name));
  const perVisitor = row => Number(row.visitors) ? num(Math.round(Number(row.pageviews) / Number(row.visitors) * 10) / 10) : '—';
  const headers = live ? ['Проект','Поток',{t:'Просмотры',n:1},{t:'Посетители',n:1},{t:'Сессии',n:1},{t:'Просмотры / посетитель',n:1},{t:'Время на странице',n:1},{t:'Глубина',n:1},{t:'Люди',n:1},{t:'Боты',n:1},{t:'Не определён',n:1},{t:'Конверсии',n:1},{t:'CRM',n:1},'']
    : ['Проект','Поток',{t:'События',n:1},{t:'Сессии',n:1},{t:'Конверсии',n:1},{t:'CRM',n:1},''];
  return table(headers, ranked.map(row => {
    const color = /^#[0-9a-f]{6}$/i.test(row.color) ? row.color : '#3a7864';
    const count = Number(live ? row.pageviews : row.events) || 0;
    const common = [
      `<td><div class="project-cell"><span class="project-mark" style="--mark:${color}">${escape(row.mark || row.name[0])}</span><div><a href="${projectHref('overview',row.id)}">${escape(row.name)}</a><small>${escape(domain(row.url))}</small>${(row.tags || []).map(tag => `<small class="row-tag">${escape(tag)}</small>`).join('')}</div></div></td>`,
      `<td><span class="tag${count ? ' on' : ''}">${count ? (state.mode === 'demo' ? 'Демо-поток' : 'Есть просмотры') : 'Ожидает трафика'}</span></td>`,
    ];
    const metrics = live
      ? [cell(num(row.pageviews),true),cell(num(row.visitors),true),cell(num(row.sessions),true),cell(perVisitor(row),true),
         cell(row.avg_time_seconds ? num(row.avg_time_seconds) + ' с' : '—',true),
         cell(row.avg_scroll_depth ? num(row.avg_scroll_depth) + '%' : '—',true),
         cell(num(row.human_visitors),true),cell(num(row.bot_visitors),true),cell(num(row.unknown_visitors),true),cell(num(row.conversions),true),cell(row.conversions ? num(row.linked) + ' / ' + num(row.conversions) : '—',true)]
      : [cell(num(row.events),true),cell(num(row.sessions),true),cell(num(row.conversions),true),cell(row.conversions ? num(row.linked) + ' / ' + num(row.conversions) : '—',true)];
    return [...common,...metrics,`<td class="row-actions"><a class="text-link" href="${projectHref('overview',row.id)}" aria-label="Открыть ${escape(row.name)}">Открыть ↗</a><a class="text-link" href="${projectHref('reports',row.id,'',{report:'countries'})}" title="Отчёт по странам">Страны ↗</a><a class="text-link" href="${projectHref('reports',row.id,'',{report:'events'})}" title="Типы событий">События ↗</a><button class="button" type="button" data-action="tags" data-id="${escape(row.id)}">Теги</button></td>`];
  }), 'Проекты не найдены.');
}

function modules() {
  return `<div class="modules section-gap">${[
    ['route','Сквозная аналитика','Первое и последнее касание, конверсии и доля конверсий со связанной сделкой.','attribution','Открыть атрибуцию'],
    ['layers','Поведенческие фичи','Сессии с вовлечением, возвраты и доля сессий с целевым действием.','features','Смотреть фичи'],
    ['terminal','Отчёты проекта','Трафик, страны, страницы, источники и события; каталог расширяется через реестр отчётов.','reports','Открыть отчёты'],
  ].map(([glyph,title,copy,page,label]) => `<section class="panel module">${icon(glyph)}<h2>${title}</h2><p>${copy}</p>${link(page,label)}</section>`).join('')}</div>`;
}

function pageHead(title, copy, action = '') {
  return `<div class="page-head"><div><span class="eyebrow">VIBEMETRICS / WORKSPACE</span><h1>${title}</h1><p>${copy}</p></div>${action}</div>`;
}

function pagesPanel() {
  const rows = (state.snapshot.pages || []).map(row => [
    cell(row.page), cell(num(row.views),true), cell(num(row.visitors),true),
    cell(row.avg_time_seconds ? num(row.avg_time_seconds) + ' с' : '—'),
    cell(row.avg_scroll_depth ? num(row.avg_scroll_depth) + '%' : '—'),
  ]);
  return panel('Страницы','Просмотры, посетители, время на странице и глубина прокрутки.',
    table(['Страница','Просмотры','Посетители','Среднее время','Глубина'],rows,'Пока нет событий page_view.'));
}

function overview() {
  const project = selection();
  return (project ? pageHead(escape(project.name), escape(domain(project.url)), link('projects','К реестру')) : state.mode === 'live' ? pageHead('Обзор','Посетители, просмотры и активность выбранных сайтов.') : hero())
    + controls() + dataError() + kpis()
    + `<div class="analytics-grid">${panel(state.mode === 'live' ? 'Просмотры по дням' : 'События по дням',state.mode === 'live' ? 'Страничные просмотры · предыдущий период пунктиром' : 'Все события выбранных проектов',chart(),'<div class="control-group"><span class="key">Период</span><span class="key prev">Предыдущий</span></div>')}
      ${panel('Каналы конверсий',state.model === 'first' ? 'Первое касание в периоде' : 'Последнее касание до цели',channels(),link('attribution','Разбивка'))}</div>`
    + (state.mode === 'live' ? pagesPanel() : '')
    + panel(project ? 'Данные проекта' : 'OpenMVP Stat', project ? 'Сводка выбранного проекта' : 'Реестр сети · проекты, поток событий и связки с CRM', projectTable(state.snapshot.projects), `<a class="button" href="${projectHref('projects')}">Все проекты ↗</a>`)
    + modules();
}

function dataError() {
  if (state.busy) return callout('Обновляем данные ClickHouse…');
  return state.error ? callout('ClickHouse временно недоступен. Проверьте соединение и повторите запрос. ' + button('retry','Повторить'),true) : '';
}

function tagBar() {
  const counts = {};
  state.snapshot.projects.forEach(row => (row.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; }));
  const tags = Object.keys(counts).sort((a,b) => a.localeCompare(b,'ru'));
  if (!tags.length) return '';
  const chip = (tag, label, count) => `<button class="chip${(state.tag || '') === tag ? ' active' : ''}" type="button" data-action="tag" data-tag="${escape(tag)}">${escape(label)}<span>${count}</span></button>`;
  return `<div class="tag-bar" role="group" aria-label="Фильтр по тегам">${chip('', 'Все', state.snapshot.projects.length)}${tags.map(tag => chip(tag, tag, counts[tag])).join('')}</div>`;
}

function tagSummary() {
  const rows = state.snapshot.projects;
  const cards = [
    ['Посетители', num(total(rows,'visitors')), 'Уникальные посетители сайтов с тегом «' + escape(state.tag) + '»', 'users'],
    ['Просмотры', num(total(rows,'pageviews')), 'Просмотры страниц за период', 'pulse'],
    ['Люди · вероятно', num(total(rows,'human_visitors')), 'По User-Agent браузера', 'target'],
    ['Боты', num(total(rows,'bot_visitors')), 'UA совпал с bot-сигнатурой', 'layers'],
  ];
  return `<div class="kpis section-gap">${cards.map(([title,value,note,glyph]) => `<div class="kpi"><div class="kpi-top"><span>${title}</span>${icon(glyph)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`).join('')}</div>`;
}

function tagHourly() {
  const data = state.snapshot.hourly || [];
  if (!data.some(point => point.visitors)) return '';
  const top = Math.max(1, ...data.map(point => point.visitors));
  const cols = data.map(point => `<div class="hour-col"><i style="height:${Math.round(100 * point.visitors / top)}%" title="${point.hour}:00 UTC — ${num(point.visitors)}"></i><span>${point.hour}</span></div>`).join('');
  return panel('Посетители по часам','Уникальные посетители по часам суток (UTC) внутри выбранного периода.',`<div class="hourly">${cols}</div>`);
}

function projectPage() {
  const tagView = state.tag ? tagSummary() + tagHourly() : '';
  return pageHead('OpenMVP Stat','Реестр сайтов: просмотры, посетители, тип трафика и результаты по каждому проекту.',button('add','Новый проект','plus','primary'))
    + controls() + dataError() + tagBar() + tagView + panel('Реестр проектов','Встроенный каталог можно расширять своими проектами. Кнопка «Теги» в строке назначает теги сайту.',
      '<div id="project-table">' + projectTable(filteredProjects()) + '</div>',
      `<input id="project-filter" type="search" aria-label="Поиск проекта" placeholder="Проект или домен" value="${escape(state.search)}">`);
}
function filteredProjects() {
  const query = state.search.trim().toLocaleLowerCase('ru');
  return state.snapshot.projects
    .filter(row => [row.name,row.url,row.id].some(value => String(value || '').toLocaleLowerCase('ru').includes(query)))
    .filter(row => !state.tag || (row.tags || []).includes(state.tag));
}

function eventPage() {
  return pageHead('События','Просматривайте последние принятые события по проектам и сессиям.') + controls() + dataError()
    + panel('Журнал событий','Одна логическая запись page_view на страницу; дополнительные события только при явном вызове.',table(['Время UTC','Проект','Событие','Страница','Сессия','Канал','Тип трафика','Страна','Время','Глубина'],state.snapshot.events.map(row => [
      cell(row.timestamp),cell(projects.find(p => p.id === row.project_id)?.name || row.project_id),
      `<td><code>${escape(row.event_name)}</code></td>`,cell(row.page || '—'),cell(row.session_id),cell(channelName(row.channel)),
      cell(trafficLabel(row.traffic_type)),cell(countryLabel(row.country_code)),
      cell(row.duration_ms ? (Number(row.duration_ms) / 1000).toFixed(1) + ' с' : '—'),cell(row.scroll_depth ? num(row.scroll_depth) + '%' : '—'),
    ])));
}

function attributionPage() {
  const choice = '<select id="model-select" aria-label="Модель атрибуции"><option value="last">Последнее касание</option><option value="first">Первое касание</option></select>';
  return pageHead('Атрибуция','Сравните каналы по первому и последнему касанию. CRM-сделки связываются с конверсией по общему идентификатору клиента.',choice)
    + controls() + dataError() + panel('Каналы и CRM','Касания ищутся в пределах выбранного периода до момента цели. Выручка отражает сумму связанных сделок в USD.',table(['Канал','Конверсии','С CRM','Выручка, USD'],state.snapshot.attribution.map(row => [
      cell(channelName(row.channel)),cell(num(row.conversions),true),cell(num(row.linked),true),cell(num(row.revenue),true),
    ])));
}

function featuresPage() {
  return pageHead('Поведенческие фичи','Разложите поток событий на показатели сессий и посетителей.') + controls() + dataError()
    + panel('Словарь фичей','Срез по выбранным проектам и периоду.',table(['Признак','Значение','Определение'],state.snapshot.features.map(row => [cell(row.feature),cell(num(row.value),true),cell(row.definition)])));
}

const prompts = {
  summary: 'Собери сводку по просмотрам страниц, посетителям, вероятным людям/ботам и странам. Сравни просмотры с предыдущим периодом и укажи сайт с максимальным числом посетителей.',
  crm: 'Сравни каналы по первому и последнему касанию. Покажи число конверсий, связку с CRM и выручку по каждому каналу. Укажи период.',
  behavior: 'Покажи время и глубину по страницам, вовлечённые и вернувшиеся сессии, а также тип трафика human/bot/unknown. Объясни определения и ограничения UA-классификации.',
};
function reportText() {
  const s = state.snapshot;
  const lead = [...s.projects].sort((a,b) => Number(b.conversions)-Number(a.conversions))[0];
  const events = total(s.daily, state.mode === 'live' ? 'pageviews' : 'events');
  const before = total(s.previous, state.mode === 'live' ? 'pageviews' : 'events');
  const metricLabel = state.mode === 'live' ? 'Просмотры страниц' : 'События';
  const topCountries = (s.countries || []).slice(0,5).map(row => countryLabel(row.country_code) + ': ' + num(row.visitors)).join(', ') || 'нет данных';
  const base = ['VibeMetrics · ' + (selection()?.name || 'Все проекты'), dateRange() + ' · ' + (state.mode === 'live' ? 'ClickHouse' : 'Демо-данные'), ''];
  const contents = {
    summary: state.mode === 'live' ? [
      metricLabel + ': ' + num(events), metricLabel + ' в предыдущем периоде: ' + num(before),
      'Посетители по сайтам: ' + num(total(s.projects,'visitors')),
      'Люди · вероятно: ' + num(total(s.projects,'human_visitors')) + ' · боты: ' + num(total(s.projects,'bot_visitors')),
      'Топ стран: ' + topCountries,
      'Конверсии: ' + num(total(s.projects,'conversions')),
      'Лидер по конверсиям: ' + (lead?.conversions ? lead.name + ' · ' + num(lead.conversions) : 'нет данных'),
    ] : [
      'События: ' + num(events), 'События в предыдущем периоде: ' + num(before),
      'Сессии: ' + num(total(s.projects,'sessions')), 'Конверсии: ' + num(total(s.projects,'conversions')),
      'Лидер по конверсиям: ' + (lead?.conversions ? lead.name + ' · ' + num(lead.conversions) : 'нет данных'),
    ],
    crm: ['Модель: ' + (state.model === 'first' ? 'первое касание' : 'последнее касание'), ...s.attribution.map(row => channelName(row.channel) + ' · конверсий ' + num(row.conversions) + ' · с CRM ' + num(row.linked) + ' · USD ' + num(row.revenue))],
    behavior: s.features.map(row => row.feature + ' · ' + num(row.value) + ' · ' + row.definition),
  };
  return base.concat(contents[state.report].length ? contents[state.report] : ['За период данных нет.']).join('\n');
}

const standardReports = [
  { id:'traffic', title:'Посетители и просмотры', detail:'Тип посетителя берётся по последнему page_view периода; User-Agent классифицируется эвристически, не абсолютно.', render:s => table(['Тип трафика','Посетители','Просмотры'],(s.traffic||[]).map(r => [cell(trafficLabel(r.traffic_type)),cell(num(r.visitors),true),cell(num(r.pageviews),true)]),'За период нет page_view.') },
  { id:'countries', title:'Страны', detail:'Страна последнего page_view посетителя за период; GeoIP приблизительная, IP в ClickHouse не сохраняется.', render:s => table(['Страна','Код','Посетители','Просмотры'],(s.countries||[]).map(r => [cell(countryLabel(r.country_code)),cell(r.country_code),cell(num(r.visitors),true),cell(num(r.pageviews),true)]),'Нет данных для географии.') },
  { id:'pages', title:'Страницы', detail:'Популярность и вовлечённость по пути страницы.', render:s => table(['Страница','Просмотры','Посетители','Среднее время','Глубина'],(s.pages||[]).map(r => [cell(r.page),cell(num(r.views),true),cell(num(r.visitors),true),cell(r.avg_time_seconds ? num(r.avg_time_seconds)+' с' : '—'),cell(r.avg_scroll_depth ? num(r.avg_scroll_depth)+'%' : '—')]),'Страниц пока нет.') },
  { id:'sources', title:'Источники и CRM', detail:'Каналы, целевые действия и связанные сделки.', render:s => table(['Канал','Конверсии','С CRM','Выручка, USD'],(s.attribution||[]).map(r => [cell(channelName(r.channel)),cell(num(r.conversions),true),cell(num(r.linked),true),cell(num(r.revenue),true)]),'Конверсий пока нет.') },
  { id:'events', title:'Типы событий', detail:'Только просмотры и явно заданные приложением события.', render:s => table(['Событие','Количество','Конверсии'],(s.top_events||[]).map(r => [cell(r.event_name),cell(num(r.events),true),cell(num(r.conversions),true)]),'Событий пока нет.') },
];

function reportsPage() {
  const selected = standardReports.find(r => r.id === state.standardReport) || standardReports[0];
  const standardSelect = `<select id="standard-report-select" aria-label="Стандартный отчёт">${standardReports.map(r => `<option value="${r.id}"${r.id === selected.id ? ' selected' : ''}>${r.title}</option>`).join('')}</select>`;
  const standardPanel = state.mode === 'live' ? panel(selected.title,selected.detail,selected.render(state.snapshot),standardSelect) : '';
  const options = '<select id="report-select" aria-label="Шаблон отчёта"><option value="summary">Сводка сети</option><option value="crm">Атрибуция и CRM</option><option value="behavior">Поведение</option></select>';
  const context = 'Проект: ' + (selection()?.name || 'вся сеть') + '. Период: ' + state.days + ' дней. ';
  return pageHead('Отчёты','Стандартные отчёты выбранного проекта и расширяемый каталог.')
    + controls() + dataError() + standardPanel
    + panel('Запрос для AI-агента','Готовый запрос для MCP-клиента по текущему проекту и периоду.',`<div class="detail"><p id="agent-prompt">${escape(context + prompts[state.report])}</p><div class="control-group section-gap">${button('copy','Копировать запрос','file')}${button('report','Собрать сводку','terminal','primary')}</div></div>`,options)
    + (state.reportReady ? panel('Сводка из данных','Результат по выбранному шаблону.',`<pre class="code-block">${escape(reportText())}</pre>`,button('report-download','Скачать TXT','download')) : '');
}

function sourcesPage() {
  const host = state.mode === 'live' ? 'API подключён. События и агрегаты читаются из вашего ClickHouse.' : 'В этом экземпляре открыт демонстрационный набор. В архиве есть API и Compose для подключения своих данных.';
  return pageHead('Источники данных','Контур для сайта, приложения и CRM в вашей инфраструктуре.',state.mode === 'demo' ? `<a class="button primary" href="./downloads/vibemetrics-self-hosted.zip" download>${icon('download')} Скачать self-hosted комплект</a>` : '')
    + callout(host)
    + panel('Порядок подключения','ClickHouse хранит события, касания и идентификаторы CRM.',`<ol class="steps">
      <li><strong>Разверните стек.</strong> Распакуйте архив, создайте <code>.env</code> по примеру и запустите Docker Compose.</li>
      <li><strong>Добавьте проект.</strong> Задайте стабильный ID в OpenMVP Stat. Он используется в API и MCP.</li>
      <li><strong>Подключите сайт.</strong> Вставьте <code>&lt;script ... /tracker.js&gt;</code>; он пишет один логический <code>page_view</code> на страницу, обновляя время/глубину тем же ID. Дополнительные события создаются только явным вызовом.</li>
      <li><strong>Передавайте серверные события.</strong> Для интеграции с backend используйте <code>POST /api/events</code>.</li>
      <li><strong>Свяжите CRM.</strong> Отправляйте сделку в <code>POST /api/crm</code> с тем же <code>person_id</code>, что у событий проекта.</li>
    </ol><pre class="code-block">cp .env.example .env
# Заполните .env своими значениями
docker compose up --build -d</pre>`)
    + panel('Контракт событий','Используйте стабильные идентификаторы сессии, клиента и события.',`<pre class="code-block">{
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
  return pageHead('Выгрузки и MCP','Скачайте данные выбранного проекта или подключите к ним MCP-агента.') + controls() + dataError()
    + `<div class="modules">${[
      ['download','Проекты · CSV','События, сессии, конверсии и CRM по проектам.','csv','Скачать CSV'],
      ['file','Срез · JSON','Проекты, ряды по дням, атрибуция, фичи и последние события.','json','Скачать JSON'],
      ['route','Атрибуция · CSV','Канал, число конверсий, CRM и выручка по выбранной модели.','attr-csv','Скачать CSV'],
    ].map(([glyph,title,copy,action,label]) => `<section class="panel module">${icon(glyph)}<h2>${title}</h2><p>${copy}</p>${button(action,label,'download')}</section>`).join('')}</div>`
    + `<div class="section-gap">${panel('Подключение MCP','Локальный stdio-сервер из self-hosted комплекта. Доступ только к чтению.',`<pre class="code-block">python3 selfhost/mcp_server.py</pre><div class="detail"><p><code>list_projects</code> · <code>get_snapshot</code> · <code>export_csv</code></p><p>Для клиентской конфигурации используйте абсолютный путь к файлу и переменные <code>VM_API_URL</code>, <code>VM_READ_TOKEN</code>.</p></div>`,link('sources','Развёртывание'))}</div>`;
}

function mcpPage() {
  const skills = [
    ['vibemetrics-analytics','Сводка проектов','Сравнивайте события и сессии по проектам и периодам.'],
    ['vibemetrics-attribution','Атрибуция','Разбирайте first/last touch, конверсии и связанные CRM-сделки.'],
    ['vibemetrics-behavior','Поведение','Интерпретируйте доступные feature-метрики и последние события.'],
  ];
  const skillCards = skills.map(([id,title,copy]) => `<section class="panel module"><h2>${title}</h2><p>${copy}</p><a class="text-link" href="/skills/${id}/SKILL.md" download>Скачать SKILL.md ↗</a></section>`).join('');
  const config = JSON.stringify({mcpServers:{vibemetrics:{command:'python3',args:['/opt/vibemetrics/selfhost/mcp_server.py'],env:{VM_API_URL:'http://127.0.0.1:18080',VM_READ_TOKEN:'<read-token>'}}}},null,2);
  return pageHead('MCP для агентов','Подключите VibeMetrics к MCP-клиенту и читайте аналитику через стандартные инструменты.','<a class="button" href="/docs/mcp.html">Документация ↗</a>')
    + callout('Read-only MCP · транспорт stdio · доступ к данным требует VM_READ_TOKEN.')
    + panel('Инструменты MCP','Срезы ограничены доступными проектами и периодами.',table(['Инструмент','Назначение','Параметры'],[
      [cell('list_projects'),cell('Список проектов и стабильных ID.'),cell('без параметров')],
      [cell('get_snapshot'),cell('Сводка, динамика, атрибуция, фичи и последние события.'),cell('project · days · model')],
      [cell('export_csv'),cell('Экспорт среза в CSV-текст.'),cell('dataset · project · days · model')],
    ]))
    + panel('Подключение MCP-клиента','Пример для локального stdio-процесса. Read token берите из конфигурации сервера.',`<pre class="code-block">${escape(config)}</pre><div class="detail"><p><a class="text-link" href="/docs/mcp.html">Полная инструкция по подключению ↗</a></p><p>Доступные модели атрибуции: first и last. Периоды: 7, 14 или 30 дней.</p></div>`)
    + panel('Skills для агентов','Готовые инструкции для типовых запросов к VibeMetrics.',`<div class="modules">${skillCards}</div>`);
}

const renderers = { overview, projects:projectPage, events:eventPage, attribution:attributionPage, features:featuresPage, reports:reportsPage, sources:sourcesPage, exports:exportsPage, mcp:mcpPage };
function render() {
  const page = route().page;
  $('#crumb').textContent = views[page];
  $('#nav-count').textContent = projects.length;
  $('#engine-status').textContent = state.error ? 'Связь потеряна' : state.mode === 'live' ? 'Свой контур подключён' : 'Демонстрационный контур';
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
  mountIcons(document);
}

async function request(path, options) {
  const response = await fetch('./api/' + path, { ...options, headers:{ Accept:'application/json', ...options?.headers } });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('API недоступен');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ошибка API');
  return result;
}
function emptySnapshot() {
  return { projects:projects.filter(p => !state.project || p.id === state.project), daily:[], previous:[], events:[], attribution:[], features:[], pages:[], traffic:[], countries:[], top_events:[], hourly:[] };
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
  notify('Файл готов');
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
  if (['csv','attr-csv','json','report','report-download'].includes(action) && (state.busy || state.error)) { notify('Дождитесь загрузки данных'); return; }
  if (action === 'csv') download('vibemetrics-' + suffix + '.csv',csv('projects'),'text/csv;charset=utf-8');
  if (action === 'attr-csv') download('vibemetrics-attribution-' + state.model + '-' + suffix + '.csv',csv('attribution'),'text/csv;charset=utf-8');
  if (action === 'json') download('vibemetrics-' + suffix + '.json',JSON.stringify({ mode:state.mode, model:state.model, days:state.days, ...state.snapshot },null,2),'application/json');
  if (action === 'report-download') download('vibemetrics-report-' + suffix + '.txt',reportText(),'text/plain;charset=utf-8');
  if (action === 'report') { state.reportReady = true; render(); $('.code-block')?.scrollIntoView({ block:'nearest' }); }
  if (action === 'copy') {
    const text = $('#agent-prompt').textContent;
    try { await navigator.clipboard.writeText(text); notify('Запрос скопирован'); }
    catch { const range = document.createRange(); range.selectNodeContents($('#agent-prompt')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); notify('Запрос выделен для копирования'); }
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
    notify('Теги сохранены');
    refresh();
  } catch (error) { $('#tags-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#project-form').addEventListener('submit',async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  const data = Object.fromEntries(Array.from(new FormData(form),([key,value]) => [key,value.trim()]));
  if (!data.name || !/^[a-z][a-z0-9-]{0,47}$/.test(data.id)) { $('#form-error').textContent = 'Укажите название и корректный ID проекта.'; return; }
  if (projects.some(p => p.id === data.id)) { $('#form-error').textContent = 'Проект с таким ID уже есть.'; return; }
  if (!data.url || !safeUrl(data.url)) { $('#form-error').textContent = 'Укажите корректный HTTPS-домен проекта.'; return; }
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
      try { await navigator.clipboard.writeText(trackerSnippet); notify('Проект добавлен. Код трекера скопирован.'); }
      catch { window.prompt('Скопируйте код трекера и вставьте его на сайт:', trackerSnippet); }
    } else notify('Проект добавлен');
    if (state.project) location.hash = '#projects';
    else refresh();
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { submit.disabled = false; }
});

const isPrivateApp = location.protocol !== 'file:' && (location.pathname.startsWith('/app/') || location.pathname.startsWith('/panel/'));
if (isPrivateApp) {
  state.mode = 'live';
  state.busy = true;
  projects = [];
  state.project = route().project;
  state.snapshot = emptySnapshot();
  migrateHash();
  render();
  request('status').then(async status => {
    if (status.mode !== 'live') throw new Error('Live API недоступен');
    projects = await request('projects');
    state.busy = false;
    followRoute();
  }).catch(error => {
    state.busy = false;
    state.error = error.message;
    state.snapshot = emptySnapshot();
    render();
  });
} else {
  migrateHash();
  followRoute();
}
