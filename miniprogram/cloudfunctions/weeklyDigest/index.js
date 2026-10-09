const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const { URL } = require('url')

// V1.3 周报摘要（手动触发版）：汇总某项目近 7 天的日记/花费/材料变化 → LLM 生成一段进展总结。
// 触发：小程序日记页「本周进展」按钮 → event { projectId }。
// LLM 环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（按函数隔离，需单独配置）；
// 未配置或失败 → 纯统计模板兜底，不影响返回。

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
    // 超时走统计兜底，不再让整个调用死掉（云端函数超时仍建议在控制台配 60s）
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

function fen2yuanStr(fen) {
  return (Number(fen || 0) / 100).toFixed(2)
}

async function collect(db, projectId, sinceIso) {
  const since = Date.now() - 7 * 86400000
  const [diaries, expenses, materials] = await Promise.all([
    db.collection('diaries').where({ project_id: projectId }).limit(200).get(),
    db.collection('expenses').where({ project_id: projectId }).limit(200).get(),
    db.collection('materials').where({ project_id: projectId }).limit(200).get(),
  ])
  const in7 = (iso) => { const t = Date.parse(iso || ''); return !isNaN(t) && t >= since }
  const d7 = (diaries.data || []).filter((d) => !d.deleted && in7(d.created_at))
  const e7 = (expenses.data || []).filter((e) => !e.deleted && in7(e.created_at))
  const m7 = (materials.data || []).filter((m) => in7(m.created_at))
  return {
    diaryCount: d7.length,
    diaryTitles: d7.slice(0, 5).map((d) => d.title || '未命名日记'),
    diaryRemarks: d7.slice(0, 5).map((d) => String(d.content || '').slice(0, 80)),
    expCount: e7.length,
    expTotal: e7.reduce((s, e) => s + Number(e.amount || 0), 0),
    expTop: e7.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 3)
      .map((e) => `${e.remark || '花费'} ¥${fen2yuanStr(e.amount)}`),
    matCount: m7.length,
    matNames: m7.slice(0, 5).map((m) => m.name || '未命名材料'),
  }
}

function statsText(s) {
  return [
    `本周新增日记 ${s.diaryCount} 篇（${s.diaryTitles.join('、') || '无'}）`,
    `本周新增花费 ${s.expCount} 笔、合计 ¥${fen2yuanStr(s.expTotal)}${s.expTop.length ? '（最大几笔：' + s.expTop.join('；') + '）' : ''}`,
    `本周新增材料 ${s.matCount} 项（${s.matNames.join('、') || '无'}）`,
  ].join('\n')
}

// LLM 配置：app_settings 集合优先（管理端独占，「我的」页 AI 设置维护），未配置回退环境变量。
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

async function callLLM(s) {
  const cfg = await getLLMConfig()
  if (!cfg) return null
  const { base, key, model } = cfg
  const prompt = [
    '这是家庭装修项目最近 7 天的活动记录，请写一段 120 字以内的「本周装修进展」中文总结，',
    '语气轻松务实，面向家庭成员；没有变化的维度不用提，结尾可给一句下周建议。',
    '',
    statsText(s),
    s.diaryRemarks.length ? '日记内容摘要：' + s.diaryRemarks.join(' / ') : '',
  ].filter(Boolean).join('\n')
  const j = await httpJson({
    method: 'POST',
    url: base,
    headers: { Authorization: 'Bearer ' + key },
    body: {
      model,
      messages: [
        { role: 'system', content: '你是装修项目助手，输出简洁温暖的中文进展总结，不要列表，不要标题。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 300, // 120 字总结的充足上限，限长即提速，避开客户端 15s 超时
      stream: false,
    },
  })
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  return txt ? String(txt).trim() : null
}

// 兜底：不用 AI 也要写成像样的周报（结构化 + 针对性提醒），而不是一行干巴巴的数字
function fallbackSummary(s) {
  const lines = []
  lines.push(
    `本周装修推进情况：新增日记 ${s.diaryCount} 篇、花费 ${s.expCount} 笔（合计 ¥${fen2yuanStr(s.expTotal)}）、材料 ${s.matCount} 项。`
  )
  if (s.expTop.length) lines.push(`花钱大头：${s.expTop.join('；')}。`)
  if (s.matNames.length) lines.push(`材料进场：${s.matNames.join('、')}。`)
  const tips = []
  if (s.diaryCount === 0) tips.push('本周还没写日记，进度细节容易忘，记得随手补记')
  if (s.matCount >= 3) tips.push('进场材料较多，收货时逐项核对型号、数量与完好度')
  if (s.expTotal >= 1000000) tips.push('单周支出已过万，建议和预算表对一下大盘')
  if (!tips.length) tips.push('节奏不错，下周继续保持记录习惯')
  lines.push('小提醒：' + tips.join('；') + '。')
  return lines.join('\n')
}

exports.main = async (event) => {
  const { projectId } = event || {}
  if (!projectId) return { ok: false, message: '请先选择项目' }
  const db = cloud.database()
  try {
    const s = await collect(db, projectId)
    let summary = null
    let ai = false
    let aiError = ''
    try {
      summary = await callLLM(s)
      ai = !!summary
    } catch (e) {
      aiError = String((e && e.message) || e)
    }
    if (!summary) summary = fallbackSummary(s)
    return { ok: true, summary, stats: statsText(s), ai, aiError }
  } catch (e) {
    return { ok: false, message: '汇总失败：' + ((e && e.message) || e) }
  }
}
