# VibeMetrics — разметка целей и постбеки

Короткая инструкция для агента/разработчика сайта. Выполнить по порядку, ~10 минут.

## 1. Метрика уже стоит или ставим

В `<head>` каждой страницы должен быть скрипт (ID и KEY выдаёт владелец VibeMetrics):

```html
<script defer src="https://vibemetrics.click/tracker.js?v=goals-3"
        data-site-id="ВАШ_ID"
        data-site-key="ВАШ_КЛЮЧ"></script>
```

**Проверка:** открыть сайт → Development Tools → Network → запрос `/api/collect` со статусом **202**.

`site_key` — публичный ключ, привязан к домену, это не секрет.

## 2. Две базовые цели (Goal1 / Goal2)

Они уже есть в общей статистике, настраивать в панели не нужно. Вызывать **только по реальному действию пользователя**:

```js
// Goal1 — первый значимый шаг (кнопка, форма, переход в корзину)
window.vibeGoal('Goal1', { place: 'pricing' });

// Goal2 — конечное действие (успешная оплата, заявка, регистрация)
window.vibeGoal('Goal2', { place: 'success' });
```

Любые свои имена целей работают так же:

```js
window.vibeGoal('purchase', { plan: 'pro', amount: 49 });
```

Можно разметить без JS-кода — атрибутами на кнопке/ссылке:

```html
<button data-vm-event="Goal1" data-vm-conversion="true">Оставить заявку</button>
<a href="/thanks" data-vm-event="Goal2" data-vm-conversion="true">Купить</a>
```

Правила: имя — латиница, цифры, `_ . : -`, до 80 символов; в `properties` — до 20 простых полей (строка/число/bool). **Не передавать** email, телефон, имя, карты, токены.

## 3. Постбеки по `clid`

Если на посадочную страницу пришли с `?clid=...`, трекер сам добавляет `clid` к событиям. Когда срабатывает цель, коллектор отправляет `POST` на настроенный URL сайта:

```json
{"project_id":"...","clid":"...","goal":"Goal1","event_id":"...","timestamp":"...","session_id":"...","person_id":"..."}
```

Настройка (делает администратор VibeMetrics):

```bash
curl -u 'admin:***' -X POST https://vibemetrics.click/panel/api/projects/goals \
  -H 'Content-Type: application/json' \
  -d '{"id":"ВАШ_ID","goals":["Goal1","Goal2","purchase"],"postback_url":"https://site.com/vm-postback"}'
```

- Если установлен `VM_POSTBACK_SECRET`, проверяйте заголовок `X-VibeMetrics-Signature` (HMAC-SHA256 от тела).
- Доставка at-least-once: возможны повторы, дедуплицируйте по `event_id`.
- Выключить: `"postback_url": ""`.

## 4. Где смотреть

- Общая статистика: `https://vibemetrics.click/` — KPI **Goal 1 / Goal 2** и колонки G1/G2 в таблице.
- Страница целей: `https://vibemetrics.click/goals?project=ВАШ_ID` — имена всех goal-событий, счётчики, сессии, последнее срабатывание.
- В панели: `/panel/goals?project=ВАШ_ID` — там же настройка целей и постбека.
- Внутри проекта: вкладки Overview / Events / Attribution / Behavior / Goals / Traffic / Countries / Pages / Sources / Event types.

## 5. Чек-лист перед запуском

1. `/api/collect` отвечает 202, события видны в снапшоте.
2. `vibeGoal` вызывается только по клику/ отправке формы, а не при загрузке страницы.
3. `clid` из URL виден в properties события.
4. Постбек-эндпоинт отвечает 200 и дедуплицирует по `event_id`.
5. В целях и properties нет персональных данных.

## 6. Частые ошибки

- **События есть, целей нет** — цель отправлена с другим именем или вызов не доходит до браузера (проверить Network/Console).
- **Старый трекер** — nginx кэширует `/tracker.js` 5 минут; добавить `?v=...` к `src` или подождать.
- **Фоновая вкладка не считается** — время на странице учитывается только для видимой вкладки с действиями; открытый фоном попандер даёт 0 активного времени.
