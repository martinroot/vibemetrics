const END = Date.UTC(2026, 10, 9);
const DAY = 86_400_000;
const channels = ['Органический поиск', 'Платный поиск', 'Прямые заходы', 'Партнёрские ссылки', 'Email'];
const sampleEvents = ['page_view', 'signup', 'checkout_opened', 'purchase'];
const metrics = ['events', 'sessions', 'conversions', 'linked', 'revenue'];

export const total = (rows, metric) => rows.reduce((sum, row) => sum + Number(row[metric] || 0), 0);


function split(amount, weights) {
  const cumulative = weights.reduce((values, weight) => [...values, values.at(-1) + weight], [0]);
  return weights.map((_, i) => Math.round(amount * cumulative[i + 1] / cumulative.at(-1))
    - Math.round(amount * cumulative[i] / cumulative.at(-1)));
}

export function demoSnapshot(projects, selection, days, model) {
  const projectRows = projects.filter(project => !selection || project.id === selection);
  const daily = [];
  const previous = [];
  const dailyProjects = projectRows.map(project => ({ ...project, ...Object.fromEntries(metrics.map(key => [key, 0])) }));
  for (let offset = 2 * days - 1; offset >= 0; offset--) {
    const date = new Date(END - offset * DAY).toISOString().slice(0, 10);
    let eventsTotal = 0;
    for (const project of dailyProjects) {
      if (!project.seed) continue;
      const n = 60 - offset;
      const noise = 0.71 + ((project.seed * 121 + (n + 61) * 1957) % 87) / 110;
      const weekly = [0.83, 0.96, 1.22, 0.98, 1.17, 1.16, 0.87][(n + 63) % 7];
      const events = Math.round((2200 + 14 * n) * (0.55 + project.cadence / 90) * weekly * noise);
      eventsTotal += events;
      if (offset >= days) continue;
      const sessions = Math.round(events / (3.6 + project.seed % 6 / 4));
      const conversions = Math.round(sessions * (0.022 + project.seed % 7 / 1000));
      project.events += events;
      project.sessions += sessions;
      project.conversions += conversions;
      project.linked += Math.round(conversions * (0.52 + project.seed % 5 / 10));
      project.revenue += conversions * (8 + project.seed % 15);
    }
    (offset < days ? daily : previous).push({ date, events: eventsTotal });
  }
  const weights = model === 'first' ? [44, 22, 13, 14, 7] : [36, 28, 17, 11, 8];
  const conversionParts = split(total(dailyProjects, 'conversions'), weights);
  const linkedParts = split(total(dailyProjects, 'linked'), weights);
  const revenueParts = split(total(dailyProjects, 'revenue'), weights);
  const attribution = channels.map((channel, i) => ({
    channel, conversions: conversionParts[i], linked: linkedParts[i], revenue: revenueParts[i],
  })).filter(row => row.conversions);
  const active = dailyProjects.filter(project => project.events);
  const sessions = total(active, 'sessions');
  const features = sessions ? [
    { feature: 'Вовлечённые сессии', value: Math.round(sessions * 0.173), definition: 'Сессии с тремя и более событиями' },
    { feature: 'Сессии с конверсией', value: total(active, 'conversions'), definition: 'Сессии с целевым событием' },
    { feature: 'Вернувшиеся посетители', value: Math.round(sessions * 0.119), definition: 'Посетители с двумя и более сессиями' },
    { feature: 'Активные посетители', value: Math.round(sessions * 0.86), definition: 'Уникальные посетители за период' },
  ] : [];
  const events = Array.from({ length: active.length ? 18 : 0 }, (_, i) => ({
    timestamp: new Date(END + 14 * 3600000 - i * 76000).toISOString(),
    project_id: active[i % active.length].id,
    event_name: sampleEvents[i % sampleEvents.length],
    session_id: 'sample-' + String(i + 7002),
    page: ['/', '/signup', '/checkout', '/confirmation'][i % 4],
    channel: channels[i % channels.length],
  }));
  return { projects: dailyProjects, daily, previous, attribution, features, events };
}
