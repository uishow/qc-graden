const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const { URL } = require('url')

// V1.4 家庭装修 AI 管家：
// - 输入：用户问题 + 客户端拼装的「项目数据快照」(snapshot)，snapshot 结构见 buildContextText()
// - 策略：客户端先读 diaries/expenses/materials/stages/rooms（已受 access.myMembers 隔离）
//         拼成快照传上来，云函数无需再做权限校验；
//         客户端未传快照时，备用：通过 projectId 服务端拉
// - 降级：LLM 未配/失败 → 返回纯文本「项目现状摘要」，前端直接展示
//
// 上下文工程：把每个领域的核心 KPI 压成短句而非塞 JSON，
// 日记/材料按房间分桶，让模型能精准回答「主卧做了什么」「水电多少钱」之类问题。

function httpJson({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const req = https.request(
      {
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method,
        headers: {
          'User-Agent': 'Mozilla/5.0', ...headers,
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
            return reject(new Error('HTTP ' + res.statusCode + ' ' + msg))
          }
          try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 160))) }
        })
      }
    )
    req.on('error', reject)
    // 13s 截止：客户端 callFunction 默认 ~15s，函数必须先于它返回；超时走「快照摘要」降级
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

// LLM 配置：app_settings 集合优先（管理端独占），未配置回退环境变量；集合读失败一律回退 env，不阻断
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

// 服务端兜底拉取：客户端未带 snapshot 时用此拉全量去构造 context
async function fetchSnapshot(projectId) {
  const db = cloud.database()
  const [stages, rooms, diaries, materials, expenses] = await Promise.all([
    db.collection('stages').where({ project_id: projectId }).limit(50).get(),
    db.collection('rooms').where({ project_id: projectId }).limit(100).get(),
    db.collection('diaries').where({ project_id: projectId, deleted: { $ne: true } }).order('updated_at', 'desc').limit(15).get(),
    db.collection('materials').where({ project_id: projectId }).limit(200).get(),
    db.collection('expenses').where({ project_id: projectId, deleted: { $ne: true } }).limit(500).get(),
  ])
  return {
    stages: stages.data || [],
    rooms: rooms.data || [],
    diaries: diaries.data || [],
    materials: materials.data || [],
    expenses: expenses.data || [],
  }
}

// 把 snapshot 各字段整理成利于 LLM 理解的纯文本（含可直读的 KPI）
//   - 防 LLM「跨字段植入」：所有 ID 一律转中文名（房间/阶段）
//   - 日记正文限长 200 字/条，避免 prompt 过长触发 token 限
function buildContextText(snap) {
  const lines = []
  if (snap.projectName) lines.push('项目名称：' + snap.projectName)
  // —— 阶段全景 ——
  const stages = snap.stages || []
  if (stages.length) {
    lines.push('')
    lines.push('【施工阶段（共 ' + stages.length + ' 段）】')
    const counts = { pending: 0, doing: 0, done: 0 }
    stages.forEach((s) => { counts[s.status || 'pending'] = (counts[s.status || 'pending'] || 0) + 1 })
    lines.push('未开始 ' + counts.pending + ' / 进行中 ' + counts.doing + ' / 已完成 ' + counts.done)
    stages.forEach((s) => {
      lines.push('- ' + s.name + '（' + statusName(s.status) + '，' +
        (s.start_date ? '起 ' + s.start_date : '未开工') +
        (s.end_date ? ' / 止 ' + s.end_date : '') + '）')
    })
  }
  // —— 房间 ——
  const rooms = snap.rooms || []
  if (rooms.length) {
    lines.push('')
    lines.push('【房间清单（' + rooms.length + ' 个）】')
    rooms.forEach((r) => lines.push('- ' + r.name))
  }
  // —— 花费 ——
  const expenses = snap.expenses || {}
  if (expenses && (expenses.total != null || expenses.byType || expenses.byStage)) {
    lines.push('')
    lines.push('【花费汇总】')
    if (expenses.total != null) lines.push('已花费合计：' + yuan(expenses.total) + ' 元')
    if (expenses.thisMonth != null) lines.push('本月新增：' + yuan(expenses.thisMonth) + ' 元')
    if (Array.isArray(expenses.byType) && expenses.byType.length) {
      lines.push('按类目：' + expenses.byType.map((t) => t.name + ' ' + yuan(t.total)).join('；'))
    }
    if (Array.isArray(expenses.byStage) && expenses.byStage.length) {
      lines.push('按阶段：' + expenses.byStage.map((t) => (t.name || '通用') + ' ' + yuan(t.total)).join('；'))
    }
  }
  // —— 材料 ——
  const materials = snap.materials || {}
  if (materials && (materials.totals || materials.byStatus || materials.byRoom)) {
    lines.push('')
    lines.push('【材料清单】')
    if (materials.totals) {
      lines.push('共 ' + materials.totals.count + ' 项，总计划 ' + yuan(materials.totals.planned) + ' 元，已购 ' +
        yuan(materials.totals.bought) + ' 元，待购 ' + yuan(materials.totals.tobuy) + ' 元')
    }
    if (Array.isArray(materials.byStatus) && materials.byStatus.length) {
      lines.push('状态分布：' + materials.byStatus.map((s) => s.name + ' ' + s.count + ' 项').join('；'))
    }
    if (Array.isArray(materials.byRoom) && materials.byRoom.length) {
      lines.push('按房间：' + materials.byRoom.map((r) => (r.room || '未分配') + ' ' + r.count + '项·' + yuan(r.total)).join('；'))
    }
    if (Array.isArray(materials.boughtList) && materials.boughtList.length) {
      lines.push('已购清单（' + materials.boughtList.length + ' 条）：')
      materials.boughtList.slice(0, 30).forEach((m) => {
        lines.push('- ' + m.name + (m.room ? '（' + m.room + '）' : '') + ' ' + yuan(m.total))
      })
    }
  }
  // —— 日记（按房间分桶，让问题「主卧有什么」能直接命中）——
  const diaries = snap.diaries || []
  if (diaries.length) {
    lines.push('')
    lines.push('【最近 ' + diaries.length + ' 条日记（按更新时间倒序）】')
    const byRoom = {}
    diaries.forEach((d) => {
      const k = (d.roomNames && d.roomNames.length) ? d.roomNames.join('/') : '未指定房间'
      if (!byRoom[k]) byRoom[k] = []
      byRoom[k].push(d)
    })
    Object.keys(byRoom).forEach((roomName) => {
      lines.push('房间【' + roomName + '】共 ' + byRoom[roomName].length + ' 条：')
      byRoom[roomName].slice(0, 8).forEach((d) => {
        const tail = (d.content || '').replace(/\s+/g, ' ').slice(0, 200)
        const stage = d.stageNames && d.stageNames.length ? ' · 阶段:' + d.stageNames.join('/') : ''
        const att = d.hasImage ? ' · 📷有附件' : ''
        lines.push('- ' + (d.diary_date || '') + ' · ' + (d.title || '无标题') + stage + att + '：' + tail)
      })
    })
  }
  return lines.join('\n')
}

function statusName(s) {
  return ({ pending: '未开始', doing: '进行中', done: '已完成' }[s] || '未开始')
}
function yuan(n) {
  const v = Math.round(Number(n || 0) / 100)
  if (!v) return '0'
  return v.toLocaleString('zh-CN')
}

async function callLLM(context, question) {
  const cfg = await getLLMConfig()
  if (!cfg) return null
  const prompt = [
    '以下是用户当前装修项目的真实数据快照（按需参考）：',
    context,
    '',
    '用户问题：' + question,
    '',
    '回答要求：',
    '- 中文。先给一句直接的结论或当下判断，再展开说明；',
    '- 紧贴项目数据回答：被问「现在到哪个阶段」就根据阶段状态列表点名；问「主卧做了什么」就只摘主卧相关的日记/材料；',
    '- 涉及下一步建议，可结合可靠的装修常识，但要有「通用建议：」标注是常识补充；',
    '- 数据未覆盖的细节（具体房间未记日记、材料未关联房间等）直接说明，不要编造；',
    '- 日记条目标了「📷有附件」的表示存有图片；用户想看图时，引导他说「显示 XX 那篇日记的附件/图片」，系统会直接把图调出来；',
    '- 涉及安全（防水/水电/燃气/承重）提醒找专业人士现场确认；',
    '- 总篇幅 200-450 字；若是「风险/下一步」类问题可用条目列。',
  ].join('\n')
  const j = await httpJson({
    method: 'POST',
    url: cfg.base,
    headers: { Authorization: 'Bearer ' + cfg.key },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: '你是用户的家庭装修管家，记得用户当前项目的所有「现场真实数据」。回答必须基于数据，没有依据的细节不要瞎编；务实、对装修小白友好、可执行。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 800, // 数据上下文较长，给回答留更多 token；客户端 15s 兜底由 13s http 截止保
      stream: false,
    },
  })
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  return txt ? String(txt).trim() : null
}

// 提取结果校验/修复层：LLM 返回 JSON 后，统一规整成写库就绪结构。
// 缺关键字段 / 字段非法 → 返回 null（让客户端判定为解析失败、走提示或重试）。
function repairExtract(coll, data) {
  if (!data || typeof data !== 'object') return null
  if (coll === 'material') {
    const name = String(data.name || '').trim()
    if (!name) return null // 材料名是必填
    const qty = Number(data.quantity || 0)
    return {
      name,
      brand: String(data.brand || '').trim(),
      quantity: qty > 0 ? qty : 1,
      unit: String(data.unit || '个').trim() || '个',
      unit_price_yuan: Math.max(0, Number(data.unit_price_yuan || 0) || 0),
      note: String(data.note || '').trim(),
    }
  }
  if (coll === 'expense') {
    const amount = Number(data.amount_yuan || 0)
    if (!(amount > 0)) return null // 金额必填且 > 0
    const valid = ['labor', 'design', 'deposit', 'other', 'material']
    let type = String(data.type || 'other').toLowerCase()
    if (valid.indexOf(type) === -1) type = 'other'
    const payDate = /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(data.pay_date || '')) ? String(data.pay_date) : ''
    return {
      amount_yuan: amount,
      type,
      pay_date: payDate, // 空 → 客户端补今天
      stage_names: Array.isArray(data.stage_names) ? data.stage_names.map(String).filter(Boolean) : [],
      remark: String(data.remark || '').trim(),
    }
  }
  if (coll === 'diary') {
    const content = String(data.content || '').trim()
    const titleRaw = String(data.title || '').trim()
    const title = (titleRaw || content.slice(0, 20) || '日记').slice(0, 20)
    return {
      title,
      content,
      diary_date: /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(data.diary_date || '')) ? String(data.diary_date) : '',
      room_names: Array.isArray(data.room_names) ? data.room_names.map(String).filter(Boolean) : [],
      stage_names: Array.isArray(data.stage_names) ? data.stage_names.map(String).filter(Boolean) : [],
    }
  }
  return null
}

// —— 录入兜底提取：自由文本 → 结构化 JSON（启发式解析失败时客户端调用）——
// 客户端传：{ mode:'extract', collection:'material'|'expense'|'diary', text, rooms:[name...], stages:[name...] }
// 返回：{ ok:true, data:{...} } 或 { ok:false, reason:'not_configured'|'unknown_collection'|'call_failed'|'empty_reply'|'parse_error', error? }
const EXTRACT_SCHEMA = {
  material: {
    desc: 'name(字符串,材料名), brand(字符串,品牌名,可空), quantity(数字,数量), unit(字符串,单位如 张/个/桶/平方), unit_price_yuan(数字,单价元,无法推断填0), note(字符串,备注/要求可空)',
    example: '{"name":"木门","brand":"欧派","quantity":3,"unit":"张","unit_price_yuan":300,"note":"本周日上门安装"}',
  },
  expense: {
    desc: 'amount_yuan(数字,金额元), type(枚举: labor人工/design设计/deposit订金定金/other其他), pay_date(YYYY-MM-DD,无法确定用今天), stage_names(字符串数组,从给定阶段名里挑,可空), remark(字符串,可空)',
    example: '{"amount_yuan":5000,"type":"labor","pay_date":"2026-10-15","stage_names":["水电改造"],"remark":"泥工师傅工钱"}',
  },
  diary: {
    desc: 'title(字符串,标题≤20字), content(字符串,正文), diary_date(YYYY-MM-DD,无法确定用今天), room_names(字符串数组,从给定房间名里挑,可空), stage_names(字符串数组,从给定阶段名里挑,可空)',
    example: '{"title":"水电验收","content":"今日水电验收完成，师傅说下周做防水","diary_date":"2026-10-15","room_names":["客厅"],"stage_names":["水电改造"]}',
  },
}

async function extractStructured(event) {
  const cfg = await getLLMConfig()
  if (!cfg) return { ok: false, reason: 'not_configured' }
  const coll = event.collection === 'diary' ? 'diary' : event.collection === 'expense' ? 'expense' : 'material'
  const schema = EXTRACT_SCHEMA[coll]
  if (!schema) return { ok: false, reason: 'unknown_collection' }
  const knownRooms = Array.isArray(event.rooms) ? event.rooms : []
  const knownStages = Array.isArray(event.stages) ? event.stages : []
  const prompt = [
    '你是装修项目的结构化数据提取器。从用户输入的自由文本里，提取出要录入「' + coll + '」字段的 JSON。',
    '',
    '字段定义（' + coll + '）：',
    schema.desc,
    '',
    '示例输出：',
    schema.example,
    '',
    '已知房间名（room_names 只能从这里挑，没有匹配就留空数组）：' + (knownRooms.length ? knownRooms.join('、') : '（无）'),
    '已知阶段名（stage_names 只能从这里挑，没有匹配就留空数组）：' + (knownStages.length ? knownStages.join('、') : '（无）'),
    '',
    '要求：',
    '- 只输出一个 JSON 对象，不要解释、不要用 markdown 代码块包裹；',
    '- 金额字段是「元」（不是分）；日期格式 YYYY-MM-DD；',
    '- 无法推断的字段填 0 / 空字符串 / 空数组，不要编造；',
    '- 严格匹配上面示例的字段名。',
    '',
    '用户输入：' + (event.text || ''),
  ].join('\n')

  let j
  try {
    j = await httpJson({
      method: 'POST',
      url: cfg.base,
      headers: { Authorization: 'Bearer ' + cfg.key },
      body: {
        model: cfg.model,
        messages: [
          { role: 'system', content: '你只输出结构化 JSON，不解释。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 600,
        stream: false,
      },
    })
  } catch (e) {
    return { ok: false, reason: 'call_failed', error: String((e && e.message) || e) }
  }
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  if (!txt) return { ok: false, reason: 'empty_reply' }
  // 去 markdown 代码块包裹 + 取首个 { 到末个 } 之间，拦截模型额外废话
  let raw = String(txt).trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}')
  if (s !== -1 && e !== -1 && e > s) raw = raw.slice(s, e + 1)
  try {
    const data0 = JSON.parse(raw)
    const data = repairExtract(coll, data0)
    if (!data) return { ok: false, reason: 'parse_error', error: '字段缺失或非法' }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, reason: 'parse_error', error: String(raw).slice(0, 200) }
  }
}

// —— 理解优先模式（LLM 优先路线 Phase A）：一句话同时判意图 + 抽字段 ——
// 客户端传：{ mode:'parse', text, rooms:[name...], stages:[name...], today:'YYYY-MM-DD' }
// 返回：{ ok:true, intent:'material'|'expense'|'diary'|'stage_update'|'none', data:{...} }
// intent='none' 表示这不是录入/修改指令（是提问或闲聊），客户端应转问答
function repairParse(data, knownRooms, knownStages) {
  if (!data || typeof data !== 'object') return null
  const intent = String(data.intent || '').trim()
  const d = (data.data && typeof data.data === 'object') ? data.data : {}
  const inList = (v, list) => !!(v && list && list.indexOf(String(v)) !== -1)
  if (intent === 'material') {
    const name = String(d.name || '').trim()
    if (!name) return null
    const qty = Number(d.quantity || 0)
    return { intent, data: { name, brand: String(d.brand || '').trim(), quantity: qty > 0 ? qty : 1, unit: String(d.unit || '个').trim() || '个', unit_price_yuan: Math.max(0, Number(d.unit_price_yuan || 0) || 0), note: String(d.note || '').trim() } }
  }
  if (intent === 'expense') {
    const amount = Number(d.amount_yuan || 0)
    if (!(amount > 0)) return null
    const valid = ['labor', 'design', 'deposit', 'other', 'material']
    let type = String(d.type || 'other').toLowerCase()
    if (valid.indexOf(type) === -1) type = 'other'
    return { intent, data: { amount_yuan: amount, type, pay_date: /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(d.pay_date || '')) ? String(d.pay_date) : '', stage_names: (Array.isArray(d.stage_names) ? d.stage_names.map(String) : []).filter((n) => inList(n, knownStages)), remark: String(d.remark || '').trim() } }
  }
  if (intent === 'diary') {
    const content = String(d.content || '').trim()
    const title = (String(d.title || '').trim() || content.slice(0, 20) || '日记').slice(0, 20)
    return { intent, data: { title, content, diary_date: /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(d.diary_date || '')) ? String(d.diary_date) : '', room_names: (Array.isArray(d.room_names) ? d.room_names.map(String) : []).filter((n) => inList(n, knownRooms)), stage_names: (Array.isArray(d.stage_names) ? d.stage_names.map(String) : []).filter((n) => inList(n, knownStages)) } }
  }
  if (intent === 'stage_update') {
    const name = String(d.stage_name || '').trim()
    const status = String(d.status || '').trim()
    if (!name || ['pending', 'doing', 'done'].indexOf(status) === -1) return null
    return { intent, data: { stage_name: name, status } }
  }
  if (intent === 'none') return { intent: 'none', data: {} }
  return null
}

async function parseIntent(event) {
  const cfg = await getLLMConfig()
  if (!cfg) return { ok: false, reason: 'not_configured' }
  const knownRooms = Array.isArray(event.rooms) ? event.rooms : []
  const knownStages = Array.isArray(event.stages) ? event.stages : []
  const today = String(event.today || '')
  const prompt = [
    '你是装修 App 的指令理解器。判断用户这句话是不是「录入/修改」指令，并抽出字段。',
    '',
    '输出一个 JSON：{"intent":"<类别>","data":{...}}',
    'intent 取值：',
    '- "material" 录入材料：data = {name, brand, quantity, unit, unit_price_yuan, note}（金额单位是元）',
    '- "expense" 录入花费：data = {amount_yuan, type, pay_date, stage_names, remark}；type 只能取 labor人工/design设计/deposit订金定金/material材料/other其他',
    '- "diary" 录入日记：data = {title, content, diary_date, room_names, stage_names}',
    '- "stage_update" 改装修进度：data = {stage_name, status}；status 只能取 pending未开始/doing进行中/done已完成',
    '- "none" 不是录入/修改（是在提问、闲聊、查数据）',
    '',
    '已知房间名（只能从这里挑，没有就留空数组）：' + (knownRooms.length ? knownRooms.join('、') : '（无）'),
    '已知阶段名（只能从这里挑，没有就留空数组）：' + (knownStages.length ? knownStages.join('、') : '（无）'),
    '今天是：' + (today || '未知'),
    '',
    '要求：',
    '- 只输出一个 JSON 对象，不要解释、不要用 markdown 代码块；',
    '- 金额单位是「元」；日期 YYYY-MM-DD；无法推断的填 0/空串/空数组，不要编造；',
    '- 判断不了类别就输出 {"intent":"none","data":{}}，不要硬猜。',
    '',
    '用户说：' + (event.text || ''),
  ].join('\n')
  let j
  try {
    j = await httpJson({
      method: 'POST', url: cfg.base,
      headers: { Authorization: 'Bearer ' + cfg.key },
      body: { model: cfg.model, messages: [{ role: 'system', content: '你只输出结构化 JSON，不解释。' }, { role: 'user', content: prompt }], temperature: 0.2, max_tokens: 600, stream: false },
    })
  } catch (e) {
    return { ok: false, reason: 'call_failed', error: String((e && e.message) || e) }
  }
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  if (!txt) return { ok: false, reason: 'empty_reply' }
  let raw = String(txt).trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}')
  if (s !== -1 && e !== -1 && e > s) raw = raw.slice(s, e + 1)
  try {
    const parsed = repairParse(JSON.parse(raw), knownRooms, knownStages)
    if (!parsed) return { ok: false, reason: 'parse_error', error: '意图或字段非法' }
    return { ok: true, intent: parsed.intent, data: parsed.data }
  } catch (err) {
    return { ok: false, reason: 'parse_error', error: String(raw).slice(0, 200) }
  }
}

exports.main = async (event) => {
  const { question } = event || {}
  // —— 理解优先模式：LLM 先判意图+抽字段，规则退为离线兜底 ——
  if (event && event.mode === 'parse') {
    return await parseIntent(event)
  }
  // —— 录入兜底提取模式：自由文本 → 结构化 JSON（启发式解析失败时客户端调用）——
  if (event && event.mode === 'extract') {
    return await extractStructured(event)
  }
  const q = String(question || '').trim()
  if (!q) return { ok: false, message: '请输入要问的问题' }
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return { ok: false, message: '未登录' }

  let snap = event && event.snapshot
  // 客户端未传 snapshot 时尝试服务端拉（仅当传了 projectId 且不在高并发场景）
  if ((!snap || !snap.stages) && event && event.projectId) {
    try {
      const raw = await fetchSnapshot(event.projectId)
      snap = {
        projectName: event.projectName || '',
        stages: (raw.stages || []).map((s) => ({ name: s.name, status: s.status || 'pending', start_date: s.start_date || '', end_date: s.end_date || '' })),
        rooms: (raw.rooms || []).map((r) => ({ name: r.name })),
        diaries: (raw.diaries || []).map((d) => ({ title: d.title, diary_date: d.diary_date, content: d.content || '', roomNames: [], stageNames: [] })),
        expenses: { total: (raw.expenses || []).reduce((s, x) => s + Number(x.amount || 0), 0) },
        materials: { totals: { count: (raw.materials || []).length, planned: 0, bought: 0, tobuy: 0 } },
      }
    } catch (e) { /* 拉失败也继续，context 可能为空 */ }
  }
  if (!snap) snap = {}
  const context = buildContextText(snap)

  let answer = null
  let ai = false
  let aiError = ''
  let reason = ''
  try {
    answer = await callLLM(context, q)
    ai = !!answer
  } catch (e) {
    aiError = String((e && e.message) || e)
  }
  // 先尝试拿配置：用于精准区分「未配置」vs「调用失败」
  let cfg = null
  try { cfg = await getLLMConfig() } catch (e) { /* ignore */ }
  if (!cfg) reason = 'not_configured'
  else if (!ai) reason = aiError ? 'call_failed' : 'empty_reply'
  if (!answer) answer = fallbackFromSnapshot(snap, q, reason, aiError)
  return { ok: true, answer, ai, aiError, reason, contextText: context, projectName: snap.projectName || '' }
}

// 降级：直接基于 snapshot 拼一段「项目现状摘要」，作为 LLM 不可用时的兜底
// reason: 'not_configured' | 'call_failed' | 'empty_reply' | ''（兜底讲不清原因）
function fallbackFromSnapshot(snap, q, reason, aiError) {
  const lines = []
  if (reason === 'not_configured') {
    lines.push('AI 管家暂未配置大模型，请前往「我的 → AI 设置」配置 base_url / api_key / model。')
    lines.push('配置完成后可重新提问；以下是当前项目的现状速览：')
  } else if (reason === 'call_failed') {
    lines.push('AI 管家调用失败：' + (aiError || '未知原因') + '。')
    lines.push('可检查「我的 → AI 设置」中的配置是否正确；以下是当前项目的现状速览：')
  } else {
    lines.push('AI 当前不可用，以下是你项目的现状速览：')
  }
  if (snap.stages && snap.stages.length) {
    const counts = { pending: 0, doing: 0, done: 0 }
    snap.stages.forEach((s) => { counts[s.status || 'pending']++ })
    const doingName = snap.stages.find((s) => s.status === 'doing')
    lines.push('· 阶段：共 ' + snap.stages.length + ' 段（未开始 ' + counts.pending + ' / 进行中 ' + counts.doing + ' / 已完成 ' + counts.done + '）' +
      (doingName ? '，当前进行中：' + doingName.name : '，当前没有正在进行的阶段'))
  }
  if (snap.expenses && snap.expenses.total != null) lines.push('· 已花费合计：' + yuan(snap.expenses.total) + ' 元')
  if (snap.materials && snap.materials.totals) {
    lines.push('· 材料：共 ' + snap.materials.totals.count + ' 项，待购 ' + yuan(snap.materials.totals.tobuy) + ' 元、已购 ' + yuan(snap.materials.totals.bought) + ' 元')
  }
  if (snap.diaries && snap.diaries.length) {
    lines.push('· 最近日记：' + snap.diaries.length + ' 条（最近：' + (snap.diaries[0].diary_date || '') + ' · ' + (snap.diaries[0].title || '') + '）')
  }
  if (q) lines.push('')
  return lines.join('\n')
}
