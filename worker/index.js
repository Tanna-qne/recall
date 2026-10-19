// 回想卡的后端：网页把资料发过来，这里调用 AI 整理成卡片，存进 KV。
// 所有接口都要带口令（请求头 X-Pass），资料和卡片不公开。
// 密钥（wrangler secret）：API_BASE、API_KEY、PASSWORD；MODEL 在 wrangler.toml 里。

const CHUNK = 12000;

const GEN_PROMPT = `把下面的资料做成记忆卡片。目标是有条理、方便记忆。

资料可能是任何格式：从 Quizlet 等导出的「术语-定义」、表格（CSV）、问答清单、笔记、课本段落、PDF 里提出来的文字（可能有页眉页脚、断行，忽略它们）。

规则：
1. 如果资料本身已经是一问一答或术语-定义，每一对就是一张卡，原样保留文字，不改写、不合并、不删。
2. 如果是笔记或段落，整理成卡片：一张卡只记一个点。正面是提问或提示，背面是简短答案，最好不超过 40 个字。
3. 只用资料里的内容，不编造，不补充资料以外的知识。
4. 按资料本身的逻辑分组，组名是这一块的主题；组内从基础到进阶排。
5. 公式一律用 LaTeX 写在 $...$ 里，比如 $E=mc^2$。字母、符号、单位照资料原样写。
6. 每张卡标出背面的「骨架」（keep）：答案会每天变一点，最后只剩骨架，帮人回想原样。骨架必须是背面里原样出现的片段：
   - 一句话：留主语、谓语动词和关键名词，比如「光合作用把光能转化为化学能」留 ["光合作用", "转化为"]；
   - 公式：只留函数名和运算符，比如 ["\\\\sin", "=", "+"]；
   - 单词：留词根或开头几个字母。
   骨架是提示，不能是答案本身：要记的数值、结论不要放进去。骨架一般占背面三分之一左右。

只输出 JSON，不要别的文字。字符串里要用引号就用中文引号「」：
{"title": "这副卡的名字", "groups": [{"name": "组名", "cards": [{"front": "……", "back": "……", "keep": ["……"]}]}]}

资料：
`;

const CHECK_PROMPT = `下面是根据资料做的记忆卡。请逐张对照资料核对：
- 背面答案是否正确、是否能在资料里找到依据；公式、字母、数字、单位是否和资料一致；
- 正面问得是否清楚，看到正面能不能明确知道要答什么。
资料原本就是一问一答的卡，只要和资料一致就 keep。

每张卡给一个结论：keep（没问题）、fix（有错或不清楚，给出改正后的 front 和 back）、drop（资料里没有依据）。拿不准的就 keep。

只输出 JSON，不要别的文字：
{"verdicts": [{"g": 组序号, "c": 卡序号, "action": "keep|fix|drop", "front": "", "back": ""}]}

卡片（序号从 0 开始）：
`;

const GREEK = new Set('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Pi Sigma Phi Psi Omega'.split(' '));

async function chat(env, prompt, system) {
  const body = { model: env.MODEL || 'DeepSeek-v4-pro', max_tokens: 16000, temperature: 0.3,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  let err = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(env.API_BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', body: JSON.stringify(body),
        headers: { Authorization: 'Bearer ' + env.API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'recall-cards/1.0' } });
      if (r.status === 401 || r.status === 402 || r.status === 403) throw new Error('模型服务拒绝了请求（HTTP ' + r.status + '）');
      if (!r.ok) { err = 'HTTP ' + r.status; continue; }
      const text = ((await r.json()).choices?.[0]?.message?.content || '').trim();
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      if (s >= 0 && e > s) return JSON.parse(text.slice(s, e + 1));
      err = '回复不是 JSON';
    } catch (e) {
      if (String(e.message).startsWith('模型服务拒绝')) throw e;
      err = e.message;
    }
  }
  throw new Error('AI 连续 3 次出错：' + err);
}

function chunks(text) {
  const out = []; let buf = '';
  for (const para of text.split(/\n\s*\n/)) {
    if (buf && buf.length + para.length > CHUNK) { out.push(buf); buf = ''; }
    buf += para + '\n\n';
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// 骨架只留提示，不留答案：公式里只留函数名和运算符；纯数字、占答案一半以上的片段都不留
function skeleton(keep, back) {
  const math = (back.match(/\$[^$]+\$/g) || []).join('');
  const letters = back.replace(/[^\p{L}\p{N}]/gu, '').length;
  const out = [];
  for (const k of keep || []) {
    if (typeof k !== 'string' || !k || !back.includes(k)) continue;
    if (math.includes(k) && !/[一-鿿]/.test(k)) out.push(...(k.match(/\\[A-Za-z]+|[=+\-<>]/g) || []).filter(t => !GREEK.has(t.slice(1))));
    else if (/[A-Za-z一-鿿]/.test(k) && k.length < letters / 2) out.push(k);
  }
  return [...new Set(out)];
}

async function makeDeck(env, text) {
  let title = ''; const groups = [];
  for (const part of chunks(text)) {
    const deck = await chat(env, GEN_PROMPT + part, '你擅长把资料整理成好记的记忆卡。');
    title = title || deck.title || '';
    const gs = (deck.groups || []).filter(g => g.cards && g.cards.length);
    try {
      const listed = JSON.stringify(gs.map(g => ({ name: g.name, cards: g.cards.map(c => ({ front: c.front, back: c.back })) })));
      const { verdicts = [] } = await chat(env, CHECK_PROMPT + listed + '\n\n资料：\n' + part, '你是严谨的审稿人。');
      for (const v of verdicts) {
        const card = gs[+v.g]?.cards?.[+v.c];
        if (!card) continue;
        if (v.action === 'drop') card._drop = true;
        else if (v.action === 'fix' && v.back) { card.front = v.front || card.front; card.back = v.back; }
      }
    } catch (e) { /* 核对失败就不核对 */ }
    for (const g of gs) {
      g.cards = g.cards.filter(c => !c._drop).map(c => ({ front: String(c.front || ''), back: String(c.back || ''), keep: skeleton(c.keep, String(c.back || '')) }));
      if (g.cards.length) groups.push({ name: String(g.name || ''), cards: g.cards });
    }
  }
  return { title, groups };
}

const json = (data, status, cors) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Pass',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.headers.get('X-Pass') !== env.PASSWORD) return json({ error: '口令不对' }, 401, cors);

    const url = new URL(req.url);
    const index = (await env.DECKS.get('index', 'json')) || [];
    try {
      if (req.method === 'GET' && url.pathname === '/decks') return json(index, 200, cors);
      const m = url.pathname.match(/^\/deck\/([\w-]+)$/);
      if (m && req.method === 'GET') {
        const deck = await env.DECKS.get('deck:' + m[1], 'json');
        return deck ? json(deck, 200, cors) : json({ error: '没有这副卡' }, 404, cors);
      }
      if (m && req.method === 'DELETE') {
        await env.DECKS.delete('deck:' + m[1]);
        await env.DECKS.put('index', JSON.stringify(index.filter(d => d.id !== m[1])));
        return json({ ok: true }, 200, cors);
      }
      if (req.method === 'POST' && url.pathname === '/generate') {
        const { title, text } = await req.json();
        if (!text || !String(text).trim()) return json({ error: '资料是空的' }, 400, cors);
        const made = await makeDeck(env, String(text).slice(0, 200000));
        const count = made.groups.reduce((n, g) => n + g.cards.length, 0);
        if (!count) return json({ error: '没整理出卡片，换份资料试试' }, 422, cors);
        const id = 'd' + Date.now().toString(36);
        const deck = { id, title: String(title || '').trim() || made.title || '未命名', groups: made.groups };
        await env.DECKS.put('deck:' + id, JSON.stringify(deck));
        index.unshift({ id, title: deck.title, count, updated: new Date().toISOString().slice(0, 10) });
        await env.DECKS.put('index', JSON.stringify(index));
        return json(deck, 200, cors);
      }
      return json({ error: '没有这个接口' }, 404, cors);
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  }
};
