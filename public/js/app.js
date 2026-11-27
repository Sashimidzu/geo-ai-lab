/* ══════════════════════════════════════════════════════════════
   ГеоИнтеллект — фронтенд
   Leaflet-карта + диалог с ИИ (через прокси /api/ask на Express)
   ══════════════════════════════════════════════════════════════
   Структура:
     1. Конфигурация типов объектов (цвета, иконки, названия)
     2. Загрузка data.json и инициализация Leaflet-карты
     3. Маркеры, popup, фильтры, выбор объекта
     4. Диалог с ИИ: формирование контекста → POST /api/ask → вывод
     5. Подсветка упомянутых ИИ объектов (строка OBJECTS в ответе)
     6. Обработка ошибок: сеть, таймаут, 401/429/413
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ══════ 1. Типы объектов ══════ */

const TYPES = {
  school:    { label: 'Школы и лицеи',      icon: '🏫', color: '#ff7a8a' },
  medical:   { label: 'Поликлиники и больницы', icon: '🏥', color: '#5b9cff' },
  park:      { label: 'Парки и сады',       icon: '🌳', color: '#5ee0a0' },
  transport: { label: 'Остановки транспорта', icon: '🚏', color: '#ffc46b' },
  education: { label: 'Вузы и библиотеки',  icon: '🎓', color: '#b388ff' },
};

const DEFAULT_CENTER = [62.0355, 129.6800]; // Центр Якутска (площадь Ленина)
const CONTEXT_LIMIT = 30;                  // лимит объектов в контексте для ИИ

/* ══════ Глобальное состояние ══════ */

let allObjects = [];        // все объекты из data.json
let markers = new Map();    // id -> L.Marker
let selectedObject = null;  // выбранный пользователем объект
let mentionedIds = [];      // id объектов из последнего ответа ИИ
let mentionCircle = null;   // L.Circle — радиус анализа из ответа ИИ
let activeFilter = new Set(Object.keys(TYPES)); // включённые типы

/* ══════ 2. Карта Leaflet ══════ */

const map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 15);

/* Тайлы карты. По умолчанию — OpenStreetMap (без ключа); при наличии
   YANDEX_MAPS_API_KEY переключаемся на русские Яндекс.Карты. */
let tileLayer = L.tileLayer('/api/tiles/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

function setTileLayer(useYandex, key) {
  if (tileLayer) map.removeLayer(tileLayer);
  if (useYandex && key) {
    document.body.classList.add('yandex-maps');
    tileLayer = L.tileLayer(
      `https://tiles.api-maps.yandex.ru/v1/tiles/?x={x}&y={y}&z={z}&lang=ru_RU&l=map&apikey=${encodeURIComponent(key)}`,
      { maxZoom: 19, attribution: '&copy; Яндекс' }
    ).addTo(map);
  } else {
    document.body.classList.remove('yandex-maps');
    tileLayer = L.tileLayer('/api/tiles/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }
}

/* Легенда */
const legend = L.control({ position: 'bottomleft' });
legend.onAdd = function () {
  const div = L.DomUtil.create('div', 'map-legend');
  div.innerHTML =
    '<b>Объекты инфраструктуры</b>' +
    Object.entries(TYPES)
      .map(
        ([, t]) =>
          `<div class="legend-row"><span class="legend-dot" style="background:${t.color}"></span>${t.label}</div>`
      )
      .join('');
  return div;
};
legend.addTo(map);

/* ══════ 3. Маркеры, popup, фильтры, выбор ══════ */

function markerIcon(type, state = '') {
  const t = TYPES[type] || { icon: '📍', color: '#666' };
  return L.divIcon({
    className: `inf-marker ${state}`,
    html: `<div class="inf-pin" style="background:${t.color}"><span>${t.icon}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -26],
  });
}

function typeLabel(type) {
  return (TYPES[type] && TYPES[type].label) || type;
}

function buildPopup(o) {
  const t = TYPES[o.type] || { color: '#666' };
  return `
    <b>${o.name}</b><br>
    <span class="popup-type" style="background:${t.color}">${typeLabel(o.type)}</span>
    <div class="popup-addr">📍 ${o.address}</div>
    ${o.description ? `<div class="popup-desc">${o.description}</div>` : ''}
    <div class="popup-select-hint">${o.id === selectedObject?.id ? '✓ Объект выбран — можно задавать вопросы ИИ' : 'Кликните маркер, чтобы выбрать объект для вопросов ИИ'}</div>
  `;
}

function createMarker(o) {
  const marker = L.marker([o.lat, o.lng], {
    icon: markerIcon(o.type, o.id === selectedObject?.id ? 'selected' : ''),
    title: o.name,
  })
    .bindPopup(buildPopup(o))
    .on('click', () => setSelectedObject(o))
    .on('popupopen', (e) => {
      // перерисовка маркера в выбранном состоянии при открытии popup
      setSelectedObject(o);
      e.target.setIcon(markerIcon(o.type, 'selected'));
    });
  markers.set(o.id, marker);
  return marker;
}

function renderMarkers() {
  markers.forEach((m) => map.removeLayer(m));
  markers.clear();
  for (const o of allObjects) {
    if (!activeFilter.has(o.type)) continue;
    createMarker(o).addTo(map);
  }
  applyHighlight(); // восстановить подсветку упомянутых объектов
}

function setSelectedObject(o) {
  selectedObject = o;
  const box = document.getElementById('selected-box');
  document.getElementById('selected-name').textContent = `${TYPES[o.type]?.icon || ''} ${o.name}`;
  box.hidden = false;
  // снять выделение со старых маркеров
  markers.forEach((m, id) => {
    if (id !== o.id) m.setIcon(markerIcon(allObjects.find((x) => x.id === id).type, ''));
  });
  const mk = markers.get(o.id);
  if (mk) mk.setIcon(markerIcon(o.type, 'selected'));
}

function clearSelection() {
  selectedObject = null;
  document.getElementById('selected-box').hidden = true;
  markers.forEach((m, id) => m.setIcon(markerIcon(allObjects.find((x) => x.id === id).type, '')));
}

/* Фильтры по типам (чекбоксы) */
function renderFilters() {
  const c = document.getElementById('filters');
  c.innerHTML = '';
  for (const [type, t] of Object.entries(TYPES)) {
    const label = document.createElement('label');
    label.className = 'filter-chip';
    label.style.setProperty('--chip-color', t.color);
    label.innerHTML = `<input type="checkbox" checked> ${t.icon} ${t.label}`;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeFilter.add(type);
      else activeFilter.delete(type);
      label.classList.toggle('off', !e.target.checked);
      renderMarkers();
    });
    c.appendChild(label);
  }
}

/* ══════ 4. Диалог с ИИ ══════ */

const chatEl = document.getElementById('chat');
const statusEl = document.getElementById('status');
const askBtn = document.getElementById('ask-btn');
const questionEl = document.getElementById('question');

function addMessage(role, html, metaText) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="bubble">${html}${metaText ? `<div class="meta">${metaText}</div>` : ''}</div>`;
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return wrap;
}

function showTyping() {
  const el = addMessage(
    'ai',
    '<span class="typing"><span>Агент анализирует объекты карты</span><span class="dots"><i></i><i></i><i></i></span></span>'
  );
  return el.querySelector('.bubble');
}

function showStatus(text, kind) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.textContent = '';
}

/**
 * Формирование контекста для ИИ (фрагмент для отчёта).
 * Чтобы не превышать лимит токенов, передаём только объекты,
 * видимые на карте, отсортированные по удалённости от центра вида
 * (или от выбранного объекта), максимум CONTEXT_LIMIT штук.
 * Если в видимой области ничего нет (карта увела далеко), берём
 * ближайшие к точке отсчёта объекты — контекст не должен пустовать.
 */
function buildContext() {
  let candidates = allObjects.filter((o) => activeFilter.has(o.type));

  const center = selectedObject || {
    lat: map.getCenter().lat,
    lng: map.getCenter().lng,
  };

  // расстояние от точки отсчёта (гаверсинус) — для сортировки
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dist = (o) => {
    const a =
      Math.sin(rad(o.lat - center.lat) / 2) ** 2 +
      Math.cos(rad(center.lat)) * Math.cos(rad(o.lat)) * Math.sin(rad(o.lng - center.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  // если выбран объект — берём только его окрестности, иначе видимую область
  const bounds = map.getBounds().pad(selectedObject ? 1.5 : 0);
  const visible = candidates.filter(
    (o) => o.id === selectedObject?.id || bounds.contains([o.lat, o.lng])
  );
  // запасной вариант: видимая область пуста → берём ближайшие объекты
  candidates = visible.length ? visible : candidates;

  // сортировка по удалённости от точки отсчёта и ограничение длины
  if (candidates.length > CONTEXT_LIMIT) {
    candidates = candidates
      .slice()
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, CONTEXT_LIMIT);
  }

  // компактная сериализация — только значимые поля
  const objects = candidates.map((o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    address: o.address,
    lat: +Number(o.lat).toFixed(6),
    lng: +Number(o.lng).toFixed(6),
    description: o.description || undefined,
  }));

  const mapCenter = {
    lat: +map.getCenter().lat.toFixed(5),
    lng: +map.getCenter().lng.toFixed(5),
  };

  return { objects, mapCenter };
}

/* Отправка вопроса на прокси */
async function askAI(question) {
  const { objects, mapCenter } = buildContext();
  const payload = {
    question,
    objects,
    selectedObject: selectedObject
      ? { id: selectedObject.id, name: selectedObject.name, type: selectedObject.type,
          address: selectedObject.address, lat: selectedObject.lat, lng: selectedObject.lng }
      : null,
    mapCenter,
  };

  const controller = new AbortController();
  const clientTimeout = setTimeout(() => controller.abort(), 40_000);

  let res;
  try {
    res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа сервера (40 с). Проверьте соединение и повторите.');
    }
    throw new Error('Сервер недоступен: ' + e.message);
  } finally {
    clearTimeout(clientTimeout);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // понятные сообщения по кодам ошибок прокси/API
    const msgs = {
      400: data.error || 'Некорректный запрос.',
      401: '⚠️ ' + (data.error || 'Токен Yandex Cloud недействителен.'),
      429: '⏳ ' + (data.error || 'Превышен лимит запросов к ИИ.'),
      413: '📏 ' + (data.error || 'Контекст слишком большой.'),
      504: '⏱️ ' + (data.error || 'Таймаут обращения к ИИ.'),
    };
    throw new Error(msgs[res.status] || `Ошибка сервера (${res.status}): ${data.error || ''}`);
  }

  return data;
}

/* ══════ 5. Подсветка упомянутых объектов ══════ */

function clearHighlight() {
  mentionedIds = [];
  markers.forEach((m, id) => {
    const o = allObjects.find((x) => x.id === id);
    if (o) m.setIcon(markerIcon(o.type, id === selectedObject?.id ? 'selected' : ''));
  });
  if (mentionCircle) {
    map.removeLayer(mentionCircle);
    mentionCircle = null;
  }
}

function applyHighlight() {
  for (const id of mentionedIds) {
    const mk = markers.get(id);
    const o = allObjects.find((x) => x.id === id);
    if (mk && o) mk.setIcon(markerIcon(o.type, 'mentioned'));
  }
}

function highlightMentioned(ids, circle) {
  clearHighlight();
  mentionedIds = ids || [];
  applyHighlight();

  if (circle && circle.lat && circle.lng) {
    mentionCircle = L.circle([circle.lat, circle.lng], {
      radius: circle.radius,
      color: '#a17bff',
      weight: 2,
      fillColor: '#a17bff',
      fillOpacity: 0.1,
      dashArray: '6 4',
    }).addTo(map);
  }

  // подлетаем к первому упомянутому объекту
  const firstId = mentionedIds[0];
  if (firstId && markers.get(firstId)) {
    map.flyTo(markers.get(firstId).getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.8 });
  }
}

/* ══════ 6. Обработка отправки формы ══════ */

document.getElementById('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = questionEl.value.trim();

  /* Валидация на клиенте (сценарий 1: пустой вопрос) */
  if (!question) {
    showStatus('Введите вопрос в поле ввода.', 'error');
    questionEl.focus();
    return;
  }

  clearStatus();
  addMessage('user', question); // вопрос пользователя
  questionEl.value = '';
  askBtn.disabled = true;

  const typingBubble = showTyping();
  const started = Date.now();

  try {
    const data = await askAI(question);
    typingBubble.closest('.msg').remove();

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    addMessage(
      'ai',
      data.answer,
      `${data.providerLabel} · ${secs} с${data.mentionedIds?.length ? ` · подсвечено объектов: ${data.mentionedIds.length}` : ''}`
    );

    // подсветка объектов из ответа ИИ (строка OBJECTS: [..])
    highlightMentioned(data.mentionedIds, data.circle);

    // чипы упомянутых объектов — клик открывает popup
    if (data.mentionedIds?.length) {
      const chips = document.createElement('div');
      chips.className = 'mentioned';
      for (const id of data.mentionedIds) {
        const o = allObjects.find((x) => x.id === id);
        if (!o) continue;
        const chip = document.createElement('button');
        chip.className = 'm-chip';
        chip.textContent = `${TYPES[o.type]?.icon || ''} ${o.name}`;
        chip.onclick = () => {
          const mk = markers.get(id);
          if (mk) mk.openPopup();
        };
        chips.appendChild(chip);
      }
      chatEl.lastChild.querySelector('.bubble').appendChild(chips);
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  } catch (err) {
    typingBubble.closest('.msg').remove();
    addMessage('ai error', err.message);      // ошибка в чате
    showStatus(err.message, 'error');         // и в статус-блоке
  } finally {
    askBtn.disabled = false;
  }
});

/* Быстрые вопросы-примеры */
document.querySelectorAll('.chip[data-q]').forEach((chip) => {
  chip.addEventListener('click', () => {
    questionEl.value = chip.dataset.q;
    document.getElementById('ask-form').requestSubmit();
  });
});

document.getElementById('clear-selection').addEventListener('click', clearSelection);

/* ══════ Загрузка данных и старт ══════ */

async function init() {
  try {
    const res = await fetch('/api/objects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allObjects = data.objects || [];
    document.getElementById('stat-objects').textContent = allObjects.length;

    renderFilters();
    renderMarkers();

    // подгоняем границы карты под все объекты
    if (allObjects.length) {
      const bounds = L.latLngBounds(allObjects.map((o) => [o.lat, o.lng]));
      map.fitBounds(bounds.pad(0.15));
    }
  } catch (e) {
    showStatus('Не удалось загрузить данные объектов: ' + e.message, 'error');
  }

  // индикатор активного ИИ-провайдера
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    const badge = document.getElementById('provider-badge');
    badge.textContent = h.providerLabel;
    if (h.provider !== 'yandex') badge.classList.add('demo');
    // русские Яндекс.Карты, если указан ключ в .env
    if (h.yandexMapsApiKey) setTileLayer(true, h.yandexMapsApiKey);
  } catch { /* индикатор не критичен */ }
}

/* Пересчёт размера карты при изменении окна (панель могла быть
   свёрнута/развёрнута после инициализации Leaflet) */
window.addEventListener('resize', () => map.invalidateSize());
setTimeout(() => {
  map.invalidateSize();
  if (allObjects.length) {
    map.fitBounds(L.latLngBounds(allObjects.map((o) => [o.lat, o.lng])).pad(0.15));
  }
}, 300);

init();
