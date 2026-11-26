# VibeMetrics — интеграция для агентов и сайтов

Публичный портал: https://vibemetrics.click/ • Исходный код: https://github.com/martinroot/vibemetrics

## 1. Регистрация проекта и установка метрики

Регистрация идемпотентна: повтор того же домена возвращает те же `id` и `site_key`.

```bash
curl -X POST https://vibemetrics.click/api/agent/sites \
  -H 'Content-Type: application/json' \
  -d '{"domain":"example.com","allowed_origins":["https://example.com"],"project_id":"example-com"}'
```

В `<head>` сайта:

```html
<script defer src="https://vibemetrics.click/tracker.js?v=goals-3"
        data-site-id="ID" data-site-key="KEY"></script>
```

`site_key` публичный, привязан к домену. Nginx кэширует `/tracker.js` 300 секунд — при обновлении трекера меняйте `?v=...`.

Готовая инструкция для рассылки: https://vibemetrics.click/downloads/vibemetrics-goals-setup.md

## 2. Статистика по доменам для агентов

`GET /api/agent/stats?domains=a.com,b.com&days=14` (или `from`/`to`, максимум 92 дня, до 50 доменов). Без `domains` — весь реестр. Авторизация: IP-привязанный ключ из `POST /api/agent/key`, `VM_READ_TOKEN` или Basic панели. Публичное чтение `/api/status`, `/api/projects`, `/api/snapshot` — до 30 req/min на IP.

## 3. Кастомные цели и постбеки по `clid`

Цели задаются конфигом проекта (имя = латиница, цифры, `_ . : -`, до 80 символов, регистроразличимо):

```bash
curl -u 'admin:***' -X POST https://vibemetrics.click/panel/api/projects/goals \
  -H 'Content-Type: application/json' \
  -d '{"id":"example-com","goals":["Goal1","Goal2","purchase"],"postback_url":"https://example.com/vm-postback"}'
```

`GET /panel/api/projects/goals` читает конфигурацию (Basic или bearer). Любое событие с именем из `goals` считается конверсией. `clid` из URL автоматически попадает в `properties` и в постбек:

```json
{"project_id":"...","clid":"...","goal":"Goal1","event_id":"...","timestamp":"...","session_id":"...","person_id":"..."}
```

Постбек — `POST`, at-least-once, дедупликация по `event_id`; при `VM_POSTBACK_SECRET` заголовок `X-VibeMetrics-Signature` содержит HMAC-SHA256 тела. Пустой `postback_url` отключает отправку.

## 4. Goal 1 / Goal 2 и активное время

Встроенные имена событий ровно `Goal1` и `Goal2` (без настройки реестра):

```js
window.vibeGoal('Goal1', { place: 'pricing' });
window.vibeGoal('Goal2', { place: 'thank-you' });
```

Они попадают в KPI на главной, колонки таблицы проектов и панель Engagement. Активное время считается только для видимой вкладки с действиями за последние 30 секунд (10 секунд стартового grace, лимит 60 секунд на интервал). Поля событий: `active_ms`, `wall_ms`, `clicks`, `keys`, `scrolls`, `moves`, `interacted`, `interaction_ms`, `refocused`. engaged-сессия = ≥10 секунд активного времени и ≥2 действий либо конверсия.

## 5. Страница целей и отчёты проекта

`/goals?project=ID` показывает имена и счётчики всех goal-событий за период; `/panel/goals?project=ID` дополнительно позволяет редактировать цели и postback URL. Внутри проекта доступны вкладки Overview / Events / Attribution / Behavior / Goals / Traffic / Countries / Pages / Sources / Event types — меню остаётся на всех срезах.

## 6. AI-разбор трафика

`GET /api/ai/insights?project=ID&days=7` (публичное чтение, кэш 6 часов) возвращает `summary`, цепочку `chain` (наблюдение → гипотеза → проверка → вывод), `anomalies` и `actions`. Модель получает только метрики выбранного проекта из снапшота. Администратор может принудительно обновить: `/panel/api/ai/insights?project=ID&days=7&force=1`. Если LLM недоступен — возвращается детерминированный разбор по правилам (`source: rules`).

Ответ дополнительно содержит:
- `grounding: {ok, unsupported}` — все числа из ответа проверены против метрик снапшота; при расхождении ответ заменяется rule-based разбором;
- `cached: true|false` — попал ли запрос в кэш (TTL задаётся `VM_AI_CACHE_TTL`, по умолчанию 21600 секунд);
- лимит новых LLM-вызовов — `VM_AI_MAX_CALLS_PER_HOUR` (по умолчанию 20): при исчерпании force-запрос получает `429`, но кэш остаётся доступен без `force`.

В UI панель AI сохраняется при переходах между всеми срезами проекта; кнопка **Download .md** выгружает разбор в Markdown.
