const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const { URL } = require('url')

// V1.3 知识库 AI 问答：检索知识库文章做上下文 → LLM 生成回答 + 引用来源。
// 检索策略（V1 轻量）：拉取可见文章（官方 + 本人项目），按「问题 2 字滑窗在 标题/摘要/正文 出现次数」打分取 top6。
// LLM：OpenAI 兼容 HTTP，环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（按函数隔离，需单独配置）。
// 未配置或失败 → 降级为「相关文章摘要拼接」，功能仍可用。

function httpJson({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          ...headers,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpJson({ method, url: new URL(res.headers.location, url).toString(), headers, body }))
        }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let msg = buf.slice(0, 300)
            try { msg = (JSON.parse(buf).error || {}).message || msg } catch (e) {}
            return reject(new Error(`HTTP ${res.statusCode} ${msg}`))
          }
          try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 160))) }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(25000, () => req.destroy(new Error('大模型请求超时')))
    if (data) req.write(data)
    req.end()
  })
}

function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) {
    if (!/chat\/completions$/i.test(s)) s += '/chat/completions'
    return s
  }
  return 'https://' + s + '/chat/completions'
}

// 相关度：问题里的 2 字滑窗在文章文本中出现次数（中文无分词的轻量匹配）
function relevanceScore(question, text) {
  const q = String(question || '').replace(/[\s，。？！、：；"']/g, '')
  const t = String(text || '')
  if (q.length < 2 || !t) return 0
  let score = 0
  for (let i = 0; i + 2 <= q.length; i++) {
    if (t.indexOf(q.slice(i, i + 2)) !== -1) score++
  }
  return score
}

function buildContext(articles, question) {
  const scored = articles
    .map((a) => ({ a, score: relevanceScore(question, (a.title || '') + ' ' + (a.summary || '') + ' ' + String(a.content || '').slice(0, 800)) }))
    .sort((x, y) => y.score - x.score)
  const top = scored.slice(0, 6).map((x) => x.a)
  const context = top
    .map((a, i) => `[${i + 1}] ${a.title}\n${String(a.summary || a.content || '').slice(0, 300)}`)
    .join('\n\n')
  const sources = top.map((a) => ({ id: a.id, title: a.title }))
  return { context, sources }
}

async function callLLM(context, question) {
  const base = normalizeBase(process.env.LLM_BASE_URL)
  const key = String(process.env.LLM_API_KEY || '').trim()
  const model = String(process.env.LLM_MODEL || 'deepseek-chat').trim()
  if (!base || !key) return null
  const prompt = [
    '以下是家庭装修知识库中检索到的内容片段：',
    context,
    '',
    `请基于以上内容回答用户问题：${question}`,
    '要求：简洁中文、分点清晰、贴合家庭装修场景；内容不足以回答时如实说明，并建议咨询专业人士。不要编造知识库里没有的结论。',
  ].join('\n')
  const j = await httpJson({
    method: 'POST',
    url: base,
    headers: { Authorization: 'Bearer ' + key },
    body: {
      model,
      messages: [
        { role: 'system', content: '你是家庭装修知识库助手，回答基于提供的知识库内容，风格务实、对装修小白友好。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      stream: false,
    },
  })
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  return txt ? String(txt).trim() : null
}

// 降级：检索命中文章的摘要拼接，保证无 LLM 也有可用回答
function fallbackAnswer(sources) {
  if (!sources.length) return '知识库里暂时没有与这个问题直接相关的内容，建议换个问法，或补充相关文章到知识库。'
  return '知识库 AI 暂不可用，先为你找到这些相关内容：\n' + sources.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
}

exports.main = async (event) => {
  const { question, projectId } = event || {}
  const q = String(question || '').trim()
  if (!q) return { ok: false, message: '请输入问题' }

  try {
    // 可见范围：官方种子文章 + 本人项目成员导入的文章（应用层隔离）
    const res = await cloud.database().collection('knowledge_articles')
      .where({ status: 'published' }).limit(100).get()
    const visible = (res.data || []).filter((a) => a.scope === 'official' || (projectId && a.project_id === projectId))

    const { context, sources } = buildContext(visible, q)
    let answer = null
    let ai = false
    let aiError = ''
    try {
      answer = await callLLM(context, q)
      ai = !!answer
    } catch (e) {
      aiError = String((e && e.message) || e)
    }
    if (!answer) answer = fallbackAnswer(sources)
    return { ok: true, answer, sources, ai, aiError }
  } catch (e) {
    return { ok: false, message: '问答失败：' + ((e && e.message) || e) }
  }
}
