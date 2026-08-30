// Cloudflare Pages Function: POST /api/analyze
// Sends the test payload to DeepSeek and returns a short strengths/weaknesses write-up.
// Required setup in the Cloudflare Pages dashboard (see README.md):
//   - Environment variable DEEPSEEK_API_KEY (secret)
//   - Optional DEEPSEEK_MODEL (defaults to "deepseek-chat")
//   - KV binding RATE_LIMIT_KV (used to enforce one analysis per IP per day)

const SYSTEM_PROMPT = `Ты — внимательный аналитик данных. Тебе присылают JSON с ответами человека на авторский психологический тест «Карта мышления»: утверждения по 12 шкалам мышления с выбранным вариантом согласия, философские дилеммы с выбранным вариантом и (не всегда) свободные текстовые ответы о себе.

Напиши краткий разбор на русском языке, обращаясь к человеку на «ты», из трёх частей:
1. Один-два абзаца — какой рисунок мышления виден в сочетании ответов.
2. "Сильные стороны" — 2-3 пункта, каждый со ссылкой на конкретные ответы или их сочетание, не общими словами.
3. "Слабые стороны / зоны роста" — 2-3 пункта, тоже на основе конкретных ответов.

Правила:
- Опирайся только на присланные данные, ничего не выдумывай.
- Это авторский исследовательский тест, а не клиническая психодиагностика: не ставь диагнозов, не используй медицинские или психиатрические термины.
- Пиши по существу, без лести и без излишней резкости.
- Не добавляй вступления, дисклеймеры о том, что ты ИИ, и не задавай встречных вопросов — сразу выдай разбор.
- Обычный текст без markdown-разметки (без **, #, списков через звёздочки). Уложись примерно в 250-350 слов.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Некорректный запрос.' }, 400);
  }

  const payload = body && body.payload;
  if (!payload || typeof payload !== 'object') {
    return jsonResponse({ error: 'Нет данных теста.' }, 400);
  }

  if (!env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: 'Анализ пока не настроен на сервере.' }, 503);
  }

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `rl:${day}:${ip}`;

  if (env.RATE_LIMIT_KV) {
    const alreadyUsed = await env.RATE_LIMIT_KV.get(rateLimitKey);
    if (alreadyUsed) {
      return jsonResponse({ error: 'Дневной лимит анализов исчерпан. Попробуй завтра.' }, 429);
    }
  }

  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';

  let upstream;
  try {
    upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        temperature: 0.4,
        max_tokens: 900
      })
    });
  } catch {
    return jsonResponse({ error: 'Не удалось связаться с сервисом анализа.' }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return jsonResponse({ error: 'Сервис анализа вернул ошибку.', detail: detail.slice(0, 300) }, 502);
  }

  const data = await upstream.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    return jsonResponse({ error: 'Пустой ответ от сервиса анализа.' }, 502);
  }

  if (env.RATE_LIMIT_KV) {
    await env.RATE_LIMIT_KV.put(rateLimitKey, '1', { expirationTtl: 60 * 60 * 26 });
  }

  return jsonResponse({ analysis: content });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
