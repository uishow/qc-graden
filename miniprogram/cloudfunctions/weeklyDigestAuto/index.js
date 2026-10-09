const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 周报定时自动生成（方案A）：定时触发器每周日 20:00 跑，遍历项目生成周报存 weekly_digests 集合。
//   定时触发：event = { Type: 'Timer', ... }，无 projectId → 处理全部项目（Promise.all 并行）。
//   手动测试：小程序端 callFunction({ name:'weeklyDigestAuto', data:{ projectId } }) 只跑单个项目。
// 幂等：同项目同周（按本周周一日期）重复执行 = 覆盖更新，不会重复堆积。
// 周报卡片在日记页展示（cloud 来源带「存为日记」按钮），逻辑与 weeklyDigest 手动版一致。

const https = require('https')
const { URL } = require('url')

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
    // 10s 截止：定时版串不起多个项目的等待，并行跑也必须每个都快进快出，超时走统计兜底
    req.setTimeout(10000, () => req.destroy(new Error('大模型请求超时')))
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

async function collect(db, projectId) {
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

// LLM 配置：app_settings 集合优先，未配置回退环境变量（与 weeklyDigest 手动版同源）
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
      max_tokens: 300,
      stream: false,
    },
  })
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  return txt ? String(txt).trim() : null
}

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

function mondayKey() {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

async function upsertDigest(db, projectId, week) {
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
  const stats = statsText(s)
  const now = new Date().toISOString()

  const exist = await db.collection('weekly_digests').where({ project_id: projectId, week }).limit(1).get()
  if (exist.data && exist.data.length) {
    await db.collection('weekly_digests').doc(exist.data[0]._id).update({
      data: { summary, stats, ai, ai_error: aiError, updated_at: now },
    })
    return { project_id: projectId, action: 'update', ai }
  }
  await db.collection('weekly_digests').add({
    data: { project_id: projectId, week, summary, stats, ai, ai_error: aiError, created_at: now },
  })
  return { project_id: projectId, action: 'create', ai }
}

exports.main = async (event) => {
  const db = cloud.database()
  const week = mondayKey()
  try {
    // 集合不存在时先建一次（服务端管理员上下文可建）
    try { await db.createCollection('weekly_digests') } catch (e) { /* 已存在则忽略 */ }

    let projectIds = []
    if (event && event.projectId) {
      projectIds = [event.projectId] // 手动测试单项目
    } else {
      const res = await db.collection('projects').limit(100).get()
      projectIds = (res.data || []).map((p) => p._id)
    }
    const results = await Promise.all(
      projectIds.map((id) =>
        upsertDigest(db, id, week).catch((e) => ({ project_id: id, error: String((e && e.message) || e) }))
      )
    )
    return { ok: true, week, projects: results.length, results }
  } catch (e) {
    return { ok: false, message: (e && e.message) || '生成失败' }
  }
}
