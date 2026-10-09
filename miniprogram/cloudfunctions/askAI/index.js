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
    // 13s 截止：小程序端 callFunction 默认约 15s 就超时报 -1，函数必须先于它返回；
    // 超时走「相关文章列表」降级，不再让整个调用死掉
    req.setTimeout(13000, () => req.destroy(new Error('大模型请求超时')))
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
    .map((a) => ({ a, score: relevanceScore(question, (a.title || '') + ' ' + (a.summary || '') + ' ' + String(a.content || '').slice(0, 1200)) }))
    .sort((x, y) => y.score - x.score)
  // 相关度为 0 的不进上下文也不进来源（避免「没有相关内容」却挂出一排无关文章）
  const top = scored.filter((x) => x.score > 0).slice(0, 6).map((x) => x.a)
  const context = top
    .map((a, i) => `[${i + 1}] ${a.title}\n${String(a.content || a.summary || '').slice(0, 600)}`)
    .join('\n\n')
  // 服务端 SDK 主键是 _id（前端适配层才叫 id），详情页跳转必须用 _id
  const sources = top.map((a) => ({ id: a._id || a.id, title: a.title }))
  return { context, sources }
}

// LLM 配置：app_settings 集合优先（管理端独占，「我的」页 AI 设置维护），未配置回退环境变量。
// 集合不存在/读失败一律回退 env，不阻断。
async function getLLMConfig() {
  try {
    const r = await cloud.database().collection('app_settings').where({ key: 'llm' }).limit(1).get()
    const d = r.data && r.data[0]
    if (d && d.api_key && d.base_url) {
      return { base: normalizeBase(d.base_url), key: String(d.api_key).trim(), model: String(d.model || 'deepseek-chat').trim() }
    }
  } catch (e) { /* 集合不存在等 → 回退环境变量 */ }
  const base = normalizeBase(process.env.LLM_BASE_URL)
  const key = String(process.env.LLM_API_KEY || '').trim()
  const model = String(process.env.LLM_MODEL || 'deepseek-chat').trim()
  return base && key ? { base, key, model } : null
}

async function callLLM(context, question) {
  const cfg = await getLLMConfig()
  if (!cfg) return null
  const { base, key, model } = cfg
  const prompt = [
    '以下是家庭装修知识库中检索到的内容片段：',
    context,
    '',
    `请回答用户问题：${question}`,
    '要求：',
    '- 中文，先给一句结论，再分点展开，总篇幅 250-400 字；',
    '- 知识库内容够用就紧贴它讲；不够时可以补充可靠的装修常识，但要用「通用建议：」标注这是知识库外的补充；',
    '- 涉及安全的事项（防水、水电、燃气、承重墙等）提醒找专业人士现场确认。',
  ].join('\n')
  const j = await httpJson({
    method: 'POST',
    url: base,
    headers: { Authorization: 'Bearer ' + key },
    body: {
      model,
      messages: [
        { role: 'system', content: '你是家庭装修助手，优先参考用户提供的知识库内容，也可结合可靠的装修常识；风格务实、对装修小白友好，回答具体、可执行。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 600, // 提升信息量的同时保住客户端 15s 内返回（约 400 字级回答）
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
