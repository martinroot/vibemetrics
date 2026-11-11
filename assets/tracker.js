(() => {
  const script = document.currentScript;
  const siteId = script?.dataset.siteId || '';
  const siteKey = script?.dataset.siteKey || '';
  if (!siteId || !siteKey || window.__vibeMetricsTrackerLoaded || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  window.__vibeMetricsTrackerLoaded = true;

  const collector = new URL('/api/collect', script.src).href;
  const visitorStorageKey = `vm:visitor:${siteId}`;
  const sessionStorageKey = `vm:session:${siteId}`;
  const sessionTimeout = 30 * 60 * 1000;
  const queue = [];
  let pageStartedAt = Date.now();
  let maxDepth = 0;
  let currentPageEvent = null;
  let activeUrl = location.href;
  let exitSent = false;
  let hiddenAt = 0;

  const uid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  };
  const storage = {
    get(store, key) { try { return store?.getItem(key) || null; } catch { return null; } },
    set(store, key, value) { try { store?.setItem(key, value); } catch {} },
  };
  let localStore, sessionStore;
  try { localStore = window.localStorage; } catch { localStore = null; }
  try { sessionStore = window.sessionStorage; } catch { sessionStore = null; }
  let visitorId = storage.get(localStore, visitorStorageKey);
  if (!visitorId) {
    visitorId = uid();
    storage.set(localStore, visitorStorageKey, visitorId);
  }
  const personStorageKey = `vm:person:${siteId}`;
  let personId = storage.get(localStore, personStorageKey) || visitorId;
  const readSession = () => {
    try {
      const value = JSON.parse(storage.get(sessionStore, sessionStorageKey) || 'null');
      if (value?.id && Date.now() - value.last < sessionTimeout) return value.id;
    } catch {}
    return '';
  };
  let sessionId = readSession() || uid();
  const touchSession = () => storage.set(sessionStore, sessionStorageKey, JSON.stringify({ id: sessionId, last: Date.now() }));
  const safeText = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max);
  const pagePath = () => {
    const path = location.pathname || '/';
    return path.slice(0, 512);
  };
  const referrerOrigin = () => {
    try { return document.referrer ? new URL(document.referrer).origin : ''; }
    catch { return ''; }
  };
  const utmValues = () => {
    const q = new URLSearchParams(location.search);
    return Object.fromEntries(['utm_source','utm_medium','utm_campaign']
      .map(k => [k, safeText(q.get(k), 128)]).filter(([,v]) => v));
  };
  const channel = () => {
    const u = utmValues();
    if (u.utm_source) return safeText([u.utm_source, u.utm_medium].filter(Boolean).join(' / '), 100);
    const ref = referrerOrigin();
    return ref || 'Direct';
  };
  const event = (name, options = {}) => ({
    event_id: uid(),
    session_id: sessionId,
    person_id: personId,
    timestamp: new Date().toISOString(),
    event_name: safeText(name, 80),
    channel: channel(),
    page: pagePath(),
    referrer: referrerOrigin(),
    is_conversion: options.conversion === true,
    duration_ms: Math.max(0, Math.min(86_400_000, Math.trunc(options.duration_ms || 0))),
    scroll_depth: Math.max(0, Math.min(100, Math.trunc(options.scroll_depth || 0))),
    properties: options.properties || {},
  });
  const flush = () => {
    if (!queue.length) return;
    const events = queue.splice(0, 20);
    const body = JSON.stringify({ site_id: siteId, site_key: siteKey, events });
    const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
    if (navigator.sendBeacon?.(collector, blob)) return;
    fetch(collector, {
      method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body,
    }).catch(() => {});
  };
  const enqueue = payload => {
    touchSession();
    queue.push(payload);
    if (queue.length >= 10) flush();
  };
  const track = (name, options = {}) => enqueue(event(name, options));
  const scrollPercent = () => {
    const root = document.documentElement;
    const total = Math.max(root.scrollHeight, document.body?.scrollHeight || 0, innerHeight);
    return Math.max(0, Math.min(100, Math.round(100 * (scrollY + innerHeight) / total)));
  };
  const startPage = () => {
    pageStartedAt = Date.now();
    maxDepth = scrollPercent();
    exitSent = false;
    hiddenAt = 0;
    currentPageEvent = event('page_view', { properties: utmValues() });
    enqueue(currentPageEvent);
  };
  const finishPage = () => {
    if (exitSent || !currentPageEvent) return;
    exitSent = true;
    const now = Date.now();
    maxDepth = Math.max(maxDepth, scrollPercent());
    const duration = Math.max(0, Math.min(86_400_000, now - pageStartedAt - (hiddenAt ? now - hiddenAt : 0)));
    currentPageEvent = { ...currentPageEvent, person_id: personId, duration_ms: duration, scroll_depth: maxDepth };
    enqueue(currentPageEvent);
    flush();
  };

  startPage();
  addEventListener('scroll', () => { maxDepth = Math.max(maxDepth, scrollPercent()); }, { passive: true });
  addEventListener('pagehide', finishPage);
  addEventListener('pageshow', event => {
    if (event.persisted) { activeUrl = location.href; startPage(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); flush(); }
    else if (hiddenAt) { pageStartedAt += Date.now() - hiddenAt; hiddenAt = 0; }
  });
  setInterval(flush, 5000);

  const onRoute = () => {
    if (location.href === activeUrl) return;
    finishPage();
    activeUrl = location.href;
    startPage();
  };
  for (const method of ['pushState','replaceState']) {
    const original = history[method];
    history[method] = function(...args) {
      const result = original.apply(this, args);
      queueMicrotask(onRoute);
      return result;
    };
  }
  addEventListener('popstate', onRoute);
  addEventListener('hashchange', onRoute);
  document.addEventListener('click', e => {
    const target = e.target.closest?.('[data-vm-event]');
    if (!target) return;
    const name = safeText(target.dataset.vmEvent, 80);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) return;
    const properties = {};
    for (const key of ['category','label','value']) {
      if (target.dataset[`vm${key[0].toUpperCase()}${key.slice(1)}`]) {
        properties[key] = safeText(target.dataset[`vm${key[0].toUpperCase()}${key.slice(1)}`], 120);
      }
    }
    track(name, { conversion: target.dataset.vmConversion === 'true', properties });
  }, true);
  window.vibeTrack = (name, properties = {}, conversion = false) => {
    const safeName = safeText(name, 80);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(safeName) || !properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    const safeProperties = {};
    for (const [key,value] of Object.entries(properties).slice(0,20)) {
      if (!['string','number','boolean'].includes(typeof value)) continue;
      safeProperties[safeText(key,32)] = safeText(value,120);
    }
    track(safeName, { conversion: conversion === true, properties: safeProperties });
  };
  window.vibeIdentify = value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 150) return;
    personId = safeText(value, 150);
    storage.set(localStore, personStorageKey, personId);
  };
  window.vibeMetrics = {
    track: window.vibeTrack,
    identify: window.vibeIdentify,
    get visitorId() { return visitorId; },
    get sessionId() { return sessionId; },
  };
})();
