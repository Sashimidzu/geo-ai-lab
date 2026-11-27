/**
 * ─────────────────────────────────────────────────────────────────
 *  Геоинтеллектуальный веб-сервис анализа городской инфраструктуры
 *  Лабораторная работа. Прокси-сервер (Express).
 *
 *  Задачи сервера:
 *   1. Раздача статического фронтенда (public/) и данных (data/data.json).
 *   2. Проксирование запросов к YandexGPT API — API-ключ и токены
 *      НИКОГДА не покидают сервер и не попадают в браузер.
 *   3. Формирование промпта: вопрос пользователя + компактный контекст
 *      (список объектов с координатами и атрибутами).
 *   4. Корректная обработка ошибок API: неверный токен (401),
 *      превышение лимита (429), таймаут (504), прочее (502).
 *   5. Демо-режим: локальный геоанализатор для работы без ключей.
 *
 *  Схема:  Браузер (Leaflet)  →  этот прокси  →  YandexGPT API
 *          :3000                    /api/ask       llm.api.cloud.yandex.net
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

/* ══════════════════ 1. Конфигурация ══════════════════ */

// Простейший загрузчик .env (без внешних зависимостей)
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
})();

const PORT = parseInt(process.env.PORT || '3000', 10);

// Провайдер ИИ: auto | yandex | demo
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'auto').toLowerCase();

const YC_FOLDER_ID = process.env.YC_FOLDER_ID || '';
const YC_API_KEY = process.env.YC_API_KEY || '';
const YC_IAM_TOKEN = process.env.YC_IAM_TOKEN || '';
const YC_OAUTH_TOKEN = process.env.YC_OAUTH_TOKEN || '';
const YC_MODEL = process.env.YC_MODEL || 'yandexgpt-lite';

const YC_COMPLETION_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const YC_IAM_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';

const REQUEST_TIMEOUT_MS = 30_000; // таймаут запроса к LLM API
const MAX_OBJECTS_IN_CONTEXT = 30; // ограничение контекста (лимит токенов)
const MAX_QUESTION_LEN = 500;

/* ══════════════════ 2. Класс ошибки API ══════════════════ */

class LlmApiError extends Error {
  constructor(message, upstreamStatus = 0) {
    super(message);
    this.name = 'LlmApiError';
    this.upstreamStatus = upstreamStatus;
  }
}

/* ══════════════════ 3. Аутентификация Yandex Cloud ══════════════════ */

// IAM-токен живёт 12 часов, поэтому кэшируем его и обновляем заранее.
let iamCache = { token: null, expiresAtMs: 0 };

async function getIamToken() {
  if (YC_IAM_TOKEN) return YC_IAM_TOKEN; // ручной токен (без авто-обновления)
  if (!YC_OAUTH_TOKEN) return null;

  // Обмен OAuth-токена на IAM-токен (авто-обновление)
  if (iamCache.token && Date.now() < iamCache.expiresAtMs) {
    return iamCache.token; // кэш ещё действителен
  }

  const res = await fetch(YC_IAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yandexPassportOauthToken: YC_OAUTH_TOKEN }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new LlmApiError(
        'OAuth-токен Yandex Cloud недействителен или просрочен. ' +
          'Получите новый на https://oauth.yandex.ru',
        res.status
      );
    }
    throw new LlmApiError(
      `Сервис IAM Yandex Cloud вернул ошибку ${res.status}. ${body.slice(0, 200)}`,
      res.status
    );
  }

  const data = await res.json();
  // Обновляем за 5 минут до истечения срока действия
  iamCache.expiresAtMs = new Date(data.expiresAt).getTime() - 5 * 60_000;
  iamCache.token = data.iamToken;
  console.log('[auth] IAM-токен обновлён, действует до', data.expiresAt);
  return iamCache.token;
}

function activeProvider() {
  if (LLM_PROVIDER === 'demo') return 'demo';
  if (LLM_PROVIDER === 'yandex') return 'yandex';
  const hasYandexKeys =
    YC_API_KEY || YC_IAM_TOKEN || (YC_OAUTH_TOKEN && YC_FOLDER_ID);
  return hasYandexKeys ? 'yandex' : 'demo';
}

/* ══════════════════ 4. Вызов YandexGPT ══════════════════ */

async function callYandexGPT(messages) {
  if (!YC_FOLDER_ID) {
    throw new LlmApiError(
      'Не задан YC_FOLDER_ID в .env — скопируйте .env.example в .env и заполните',
      0
    );
  }

  const headers = { 'Content-Type': 'application/json', 'x-folder-id': YC_FOLDER_ID };

  if (YC_API_KEY) {
    headers['Api-Key'] = YC_API_KEY; // аутентификация по API-ключу
  } else {
    const iam = await getIamToken();
    if (!iam) {
      throw new LlmApiError(
        'Нет учётных данных Yandex Cloud: укажите YC_API_KEY, YC_OAUTH_TOKEN или YC_IAM_TOKEN в .env',
        401
      );
    }
    headers['Authorization'] = `Bearer ${iam}`; // аутентификация по IAM-токену
  }

  // Тело запроса — по документации YandexGPT Completion API
  const body = {
    modelUri: `gpt://${YC_FOLDER_ID}/${YC_MODEL}`,
    completionOptions: { temperature: 0.3, maxTokens: 500 },
    messages,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(YC_COMPLETION_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new LlmApiError(
        `Превышено время ожидания ответа YandexGPT (${REQUEST_TIMEOUT_MS / 1000} с). ` +
          'Попробуйте повторить запрос.',
        504
      );
    }
    throw new LlmApiError(
      `Сетевая ошибка при обращении к YandexGPT: ${e.message}`,
      0
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    // Коды Yandex Cloud → понятные пользователю сообщения
    if (res.status === 401 || res.status === 403) {
      throw new LlmApiError(
        'Токен/ключ Yandex Cloud недействителен или просрочен (IAM-токен живёт 12 часов). ' +
          'Обновите учётные данные в .env',
        401
      );
    }
    if (res.status === 429) {
      throw new LlmApiError(
        'Превышен лимит запросов к YandexGPT (429). Подождите немного и попробуйте снова.',
        429
      );
    }
    if (res.status === 400 && /limit|token| exceeded/i.test(errText)) {
      throw new LlmApiError(
        'Превышен лимит токенов запроса — контекст слишком большой. ' +
          'Уменьшите число объектов в контексте.',
        413
      );
    }
    throw new LlmApiError(
      `YandexGPT API вернул ошибку ${res.status}: ${errText}`,
      res.status
    );
  }

  const data = await res.json();
  const text = data?.result?.alternatives?.[0]?.message?.text;
  if (!text) {
    throw new LlmApiError(
      'YandexGPT вернул пустой ответ. Повторите запрос или уменьшите контекст.',
      502
    );
  }
  return text;
}

/* ══════════════════ 5. Демо-анализатор (работает без ключей) ══════════════════
 * Локальный «ИИ на правилах»: понимает типовые вопросы на естественном
 * языке, считает расстояния по формуле гаверсинуса и отвечает по данным.
 * Нужен, чтобы демонстрация и скриншоты работали без ключей Yandex Cloud.
 */

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} км` : `${Math.round(m)} м`);

const TYPE_WORDS = {
  school: ['школ', 'гимнази', 'лице', 'учебн', 'образов'],
  medical: ['поликлиник', 'больниц', 'клиник', 'врач', 'медиц', 'здрав'],
  park: ['парк', 'сад', 'сквер', 'зелен', 'прогул'],
  transport: ['останов', 'автобус', 'троллейбус', 'трамва', 'метро', 'транспорт', 'станци', 'мцк'],
  education: ['вуз', 'университет', 'институт', 'библиотек', 'колледж', 'свфу', 'ягу'],
};

function detectTypes(q) {
  const found = [];
  for (const [type, words] of Object.entries(TYPE_WORDS)) {
    if (words.some((w) => q.includes(w))) found.push(type);
  }
  return found;
}

function detectRadiusM(q) {
  // \b в JS не работает с кириллицей, поэтому границу слова задаём
  // явно: отрицательный lookahead на букву после единицы измерения
  const m = q.match(/(\d+(?:[.,]\d+)?)\s*(км|километр[а-яё]*|метр[а-яё]*|м)(?![а-яё])/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(',', '.'));
  if (/^(км|километр)/.test(m[2])) v *= 1000;
  return v > 0 && v < 20000 ? v : null;
}

// Русские формы мнеств. числа: 1 школа / 2 школы / 5 школ
function pluralRu(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

const TYPE_NOUNS = {
  school: ['школа', 'школы', 'школ'],
  medical: ['медучреждение', 'медучреждения', 'медучреждений'],
  park: ['парк', 'парка', 'парков'],
  transport: ['остановка', 'остановки', 'остановок'],
  education: ['учебное заведение', 'учебных заведения', 'учебных заведений'],
};

function typeNoun(t, n) {
  const forms = TYPE_NOUNS[t];
  return forms ? pluralRu(n, forms[0], forms[1], forms[2]) : 'объектов';
}

function demoAnalyze(question, objects, selectedObject, mapCenter) {
  const q = question.toLowerCase();
  let types = detectTypes(q);
  const radiusM = detectRadiusM(q);
  const isCount = /сколько|количество|числ/.test(q);
  const isList = /какие|перечисл|список|найди|покажи|есть/.test(q);
  const isNearest = /ближайш|ближе|поближа|минимальн/.test(q);
  const mentionsSelection =
    /выбранн|эту|этой|этого|этот|этим|рядом с/.test(q);

  /* Тип выбранного объекта исключаем из искомых типов:
     «Сколько школ от выбранной ОСТАНОВКИ» — искомый тип «школа»,
     а «остановка» описывает лишь точку отсчёта. */
  if (selectedObject) {
    types = types.filter((t) => t !== selectedObject.type);
  }

  const anchor = selectedObject
    ? { lat: selectedObject.lat, lng: selectedObject.lng, name: selectedObject.name }
    : mapCenter
      ? { lat: mapCenter.lat, lng: mapCenter.lng, name: 'центра карты' }
      : null;

  const out = { answer: '', mentionedIds: [], circle: null };

  // Вопрос про «этот/выбранный» объект, но ничего не выбрано
  if (mentionsSelection && !selectedObject) {
    out.answer =
      'Сначала кликните объект на карте, чтобы выбрать его, затем повторите вопрос.';
    return out;
  }

  if (!anchor) {
    out.answer =
      'Не удалось определить точку отсчёта. Кликните объект на карте или переместите вид.';
    return out;
  }

  // Расстояния от точки отсчёта до всех объектов (сам объект исключаем)
  const withDist = objects
    .filter((o) => !selectedObject || o.id !== selectedObject.id)
    .map((o) => ({ o, d: haversineM(anchor.lat, anchor.lng, o.lat, o.lng) }))
    .sort((a, b) => a.d - b.d);

  /* ── «Какой объект ближе всего…» ── */
  if (isNearest) {
    const pool = types.length
      ? withDist.filter((x) => types.includes(x.o.type))
      : withDist;
    const best = pool[0];
    if (best) {
      out.answer =
        `Ближайший к «${anchor.name}» ${types.length ? typeNoun(types[0], 1) : 'объект'} — ` +
        `«${best.o.name}» (${best.o.address}), расстояние ≈ ${fmtM(best.d)}.`;
      out.mentionedIds = [best.o.id];
      return out;
    }
  }

  /* ── Вопросы с радиусом: «сколько школ в радиусе 1 км» ── */
  if (radiusM) {
    const R = radiusM;
    const pool = types.length
      ? withDist.filter((x) => types.includes(x.o.type))
      : withDist;
    const inside = pool.filter((x) => x.d <= R);

    out.circle = { lat: anchor.lat, lng: anchor.lng, radius: R };

    if (!types.length) {
      out.answer =
        `В радиусе ${fmtM(R)} от «${anchor.name}» находится ` +
        `${inside.length} ${pluralRu(inside.length, 'объект', 'объекта', 'объектов')} инфраструктуры.` +
        (inside.length ? ` Ближайший — «${inside[0].o.name}» (${fmtM(inside[0].d)}).` : '');
      out.mentionedIds = inside.slice(0, 10).map((x) => x.o.id);
      return out;
    }

    const noun = typeNoun(types[0], inside.length);
    const list = inside.map((x) => `«${x.o.name}» (${fmtM(x.d)})`).join('; ');
    if (isCount || !isList) {
      out.answer = inside.length
        ? `В радиусе ${fmtM(R)} от «${anchor.name}» ${inside.length} ${noun}: ${list}.`
        : `В радиусе ${fmtM(R)} от «${anchor.name}» нет ни одной ${TYPE_NOUNS[types[0]][0]}. ` +
          (pool[0]
            ? `Ближайший объект этого типа — «${pool[0].o.name}» в ${fmtM(pool[0].d)}.`
            : 'Объекты этого типа в данных отсутствуют.');
    } else {
      out.answer = inside.length
        ? `${inside.length} ${noun} в радиусе ${fmtM(R)} от «${anchor.name}»: ${list}.`
        : `В радиусе ${fmtM(R)} от «${anchor.name}» нет ни одной ${TYPE_NOUNS[types[0]][0]}.`;
    }
    out.mentionedIds = inside.slice(0, 10).map((x) => x.o.id);
    return out;
  }

  /* ── «Какие парки рядом с этой поликлиникой?» (без явного радиуса) ── */
  if ((isList || isCount) && types.length) {
    const NEAR = 1200; // «рядом» ≈ 1.2 км по умолчанию
    const pool = withDist.filter((x) => types.includes(x.o.type) && x.d <= NEAR);
    out.circle = { lat: anchor.lat, lng: anchor.lng, radius: NEAR };
    const noun = typeNoun(types[0], pool.length);
    if (pool.length) {
      out.answer =
        `Рядом с «${anchor.name}» (в пределах ~${fmtM(NEAR)}) ${pool.length} ${noun}: ` +
        pool.map((x) => `«${x.o.name}» (${fmtM(x.d)})`).join('; ') + '.';
      out.mentionedIds = pool.slice(0, 10).map((x) => x.o.id);
    } else {
      out.answer = `Рядом с «${anchor.name}» (в пределах ~${fmtM(NEAR)}) не найдено ни одной ` +
        `${TYPE_NOUNS[types[0]][0]}.`;
    }
    return out;
  }

  /* ── Общая статистика по набору данных ── */
  const byType = {};
  for (const o of objects) byType[o.type] = (byType[o.type] || 0) + 1;
  out.answer =
    `В загруженном наборе данных ${objects.length} объектов: ` +
    Object.entries(byType)
      .map(([t, n]) => `${n} ${typeNoun(t, n)}`)
      .join(', ') +
    `. Уточните вопрос (например: «Сколько школ в радиусе 1 км от выбранной остановки?»), ` +
    `кликнув объект на карте.`;
  return out;
}

/* ══════════════════ 6. Формирование промпта для LLM ══════════════════ */

function buildMessages(question, objects, selectedObject, mapCenter) {
  // Компактная сериализация: только значимые поля (экономия токенов)
  const compact = (o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    address: o.address,
    lat: +Number(o.lat).toFixed(6),
    lng: +Number(o.lng).toFixed(6),
    description: o.description || undefined,
  });

  const system =
    'Ты — ГИС-ассистент по городской инфраструктуре Якутска (Республика Саха (Якутия)). ' +
    'Отвечай кратко (до 120 слов) и только на основе предоставленных JSON-данных. ' +
    'Если данных для ответа недостаточно — честно скажи об этом. ' +
    'Расстояния считай по координатам: 1 градус широты ≈ 111 км, ' +
    '1 градус долготы для Якутска ≈ 52 км (или через формулу гаверсинуса). ' +
    'Если упоминаешь конкретные объекты, в самом конце ответа добавь строку вида ' +
    'OBJECTS: [id1,id2] — по ней фронтенд подсвечивает объекты на карте; ' +
    'эта строка не показывается пользователю.';

  const user =
    `Вопрос пользователя: «${question}»\n\n` +
    (selectedObject
      ? `Пользователь выбрал на карте объект: ${JSON.stringify(compact(selectedObject))}\n\n`
      : 'Объект пользователем не выбран.\n\n') +
    (mapCenter
      ? `Центр видимой области карты: lat=${Number(mapCenter.lat).toFixed(5)}, lng=${Number(mapCenter.lng).toFixed(5)}\n\n`
      : '') +
    `Список объектов инфраструктуры (JSON):\n${JSON.stringify(objects.map(compact), null, 1)}`;

  return [
    { role: 'system', text: system },
    { role: 'user', text: user },
  ];
}

// Извлекаем из ответа LLM служебную строку OBJECTS: [..] и удаляем её из текста
function extractMentions(answer) {
  const m = answer.match(/OBJECTS\s*:\s*\[([^\]]*)\]/i);
  if (!m) return { text: answer.trim(), ids: [] };
  const ids = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return {
    text: answer.replace(m[0], '').trim(),
    ids,
  };
}

/* ══════════════════ 7. Express-приложение ══════════════════ */

const app = express();
app.use(express.json({ limit: '256kb' }));

/* GET /api/objects — данные инфраструктуры для карты */
app.get('/api/objects', (_req, res) => {
  const file = path.join(__dirname, 'data', 'data.json');
  try {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: `Не удалось прочитать data/data.json: ${e.message}` });
  }
});

/* GET /api/tiles/:z/:x/:y.png — прокси тайлов OpenStreetMap.
 * Браузер обращается только к этому серверу: карта работает даже если
 * внешний CDN или прямой доступ к tile.openstreetmap.org недоступен. */
const tileCache = new Map();
const TILE_CACHE_MAX = 800;
app.get('/api/tiles/:z/:x/:y.png', async (req, res) => {
  const { z, x, y } = req.params;
  if (!/^\d{1,2}$/.test(z) || !/^\d{1,6}$/.test(x) ||
      !/^\d{1,6}$/.test(y) || Number(z) > 19) {
    return res.status(400).end();
  }
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(`https://tile.openstreetmap.org/${key}.png`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'GeoAiLab/1.0 (educational lab project)' },
    });
    if (!upstream.ok) return res.status(502).end();
    const png = Buffer.from(await upstream.arrayBuffer());
    tileCache.set(key, png);
    if (tileCache.size > TILE_CACHE_MAX) {
      tileCache.delete(tileCache.keys().next().value);
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (_e) {
    res.status(504).end();
  } finally {
    clearTimeout(timer);
  }
});

/* GET /api/health — статус и активный провайдер ИИ */
app.get('/api/health', (_req, res) => {
  const provider = activeProvider();
  res.json({
    ok: true,
    provider,
    providerLabel:
      provider === 'yandex' ? 'YandexGPT' : 'Демо-анализатор (без ключа)',
    model: provider === 'yandex' ? YC_MODEL : null,
    yandexMapsApiKey: process.env.YANDEX_MAPS_API_KEY || null,
  });
});

/* POST /api/ask — вопрос к ИИ.
 * Тело: { question, objects: [...], selectedObject?, mapCenter? }
 * Ответ: { answer, provider, mentionedIds, circle }  */
app.post('/api/ask', async (req, res) => {
  const started = Date.now();
  const { question, objects = [], selectedObject = null, mapCenter = null } = req.body || {};

  /* ── Валидация (сценарий 1: пустой вопрос) ── */
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Задайте вопрос — поле ввода пустое.' });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return res.status(400).json({
      error: `Вопрос слишком длинный (${question.length} симв., максимум ${MAX_QUESTION_LEN}).`,
    });
  }
  /* ── Ограничение контекста (сценарий 3: превышение лимита токенов) ── */
  if (!Array.isArray(objects) || objects.length === 0) {
    return res.status(400).json({ error: 'Контекст пуст — не переданы объекты карты.' });
  }
  if (objects.length > MAX_OBJECTS_IN_CONTEXT) {
    return res.status(400).json({
      error: `Слишком большой контекст: ${objects.length} объектов (лимит ${MAX_OBJECTS_IN_CONTEXT}).`,
    });
  }

  const provider = activeProvider();

  try {
    let answer, mentionedIds = [], circle = null;

    if (provider === 'yandex') {
      const messages = buildMessages(question, objects, selectedObject, mapCenter);
      const raw = await callYandexGPT(messages);
      const parsed = extractMentions(raw);
      answer = parsed.text;
      mentionedIds = parsed.ids;
    } else {
      const demo = demoAnalyze(question, objects, selectedObject, mapCenter);
      answer = demo.answer;
      mentionedIds = demo.mentionedIds;
      circle = demo.circle;
    }

    console.log(
      `[ask] provider=${provider} objects=${objects.length} ` +
        `selected=${selectedObject ? selectedObject.id : '-'} ${Date.now() - started}ms`
    );

    return res.json({
      answer,
      provider,
      providerLabel: provider === 'yandex' ? 'YandexGPT' : 'Демо-анализатор',
      mentionedIds,
      circle,
    });
  } catch (e) {
    /* ── Сценарии 2–4: неверный токен, лимит, таймаут ── */
    if (e instanceof LlmApiError) {
      const status =
        e.upstreamStatus === 401 || e.upstreamStatus === 403
          ? 401
          : e.upstreamStatus === 429
            ? 429
            : e.upstreamStatus === 504
              ? 504
              : e.upstreamStatus === 413
                ? 413
                : 502;
      console.error(`[ask] Ошибка API (${status}): ${e.message}`);
      return res.status(status).json({ error: e.message });
    }
    console.error('[ask] Непредвиденная ошибка:', e);
    return res.status(500).json({ error: `Внутренняя ошибка сервера: ${e.message}` });
  }
});

/* Статика и точка входа */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  ГеоИнтеллект-сервис запущен:');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ИИ-провайдер: ${activeProvider() === 'yandex' ? 'YandexGPT (' + YC_MODEL + ')' : 'демо-анализатор (ключи не заданы)'}`);
  console.log('──────────────────────────────────────────────');
});
