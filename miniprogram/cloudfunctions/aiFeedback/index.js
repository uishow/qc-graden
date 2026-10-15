const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// V1.0 AI 管家反馈闭环
// 安全规则：ai_feedback read/write = false → 读写必须经本函数
//
// op='log'（任意登录用户）：记录一次「AI 没帮上忙」的信号
//   传入 { signal, question, understood, reply, intent, reason, projectId }
//   signal: 'edit_diff'(用户改了字段，含标准答案) | 'cancel' | 'unparsed'
//           | 'no_result' | 'retry' | 'degraded' | 'thumb_down'
// op='list'（仅管理员）：按「signal|intent|norm」聚合，返回按出现次数倒序的分组
// op='setStatus'（仅管理员）：整组标记 状态/处理备注
//   传入 { signal, intent, norm, status, note }；status: pending|fixed|notbug|ignored
async function isManager(db, openid) {
  const r = await db.collection('members').where({ user_id: openid }).limit(50).get()
  return (r.data || []).some((x) => x.role === 'owner' || x.role === 'family')
}

// 归一化：用于把「说法不同但同类」的问题聚到一起统计出现次数
function normKey(q) {
  return String(q || '')
    .replace(/[\s，,。.；;：:！!？?、'""'「」《》()（）]/g, '')
    .replace(/\d+/g, '#')
    .slice(0, 24)
}

// 分页拉全量：不依赖单次 limit 上限（云函数端上限各环境不一致，直接 limit(500) 可能只回前 100 条）。
// 按 created_at 倒序翻页，最多 MAX_PAGES 页，避免数据量大时把函数跑超时。
const PAGE = 100
const MAX_PAGES = 10
async function fetchAll(db, where) {
  const out = []
  for (let p = 0; p < MAX_PAGES; p++) {
    let q = db.collection('ai_feedback').where(where || {})
    try { q = q.order('created_at', 'desc') } catch (e) { /* 无索引时退化为不排序 */ }
    let r
    try { r = await q.skip(p * PAGE).limit(PAGE).get() } catch (e) { break }
    const rows = (r && r.data) || []
    out.push.apply(out, rows)
    if (rows.length < PAGE) break
  }
  return out
}

function short(s, n) {
  const t = String(s == null ? '' : s)
  return t.length > n ? t.slice(0, n) + '…' : t
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return { ok: false, message: '未登录' }
  const db = cloud.database()
  const op = (event && event.op) || 'log'

  if (op === 'log') {
    const signal = String((event && event.signal) || '').slice(0, 20)
    if (!signal) return { ok: false, message: '缺少 signal' }
    const question = String((event && event.question) || '')
    try {
      await db.collection('ai_feedback').add({
        data: {
          openid, // 仅用于统计去重，前端不展示身份
          project_id: String((event && event.projectId) || ''),
          signal,
          intent: String((event && event.intent) || ''),
          norm: normKey(question),
          question: short(question, 300),
          understood: short((event && event.understood) || '', 400),
          // edit_diff 专用：用户改后的「标准答案」，与 understood 对比就是模型/规则错在哪
          fixed: short((event && event.fixed) || '', 400),
          reply: short((event && event.reply) || '', 500),
          reason: String((event && event.reason) || ''),
          status: 'pending',
          note: '',
          created_at: new Date().toISOString(),
        },
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) }
    }
  }

  let mgr = false
  try { mgr = await isManager(db, openid) } catch (e) { mgr = false }
  if (!mgr) return { ok: false, message: '仅管理员可查看 AI 反馈' }

  // 轻量摘要：只数「待处理」有几类/几条，供「我的」页角标显示（不拉全表）
  if (op === 'summary') {
    try {
      const rows = await fetchAll(db, { status: 'pending' })
      const set = {}
      rows.forEach((x) => { set[[x.signal, x.intent, x.norm].join('|')] = 1 })
      return { ok: true, pendingGroups: Object.keys(set).length, pendingRows: rows.length }
    } catch (e) {
      return { ok: true, pendingGroups: 0, pendingRows: 0 } // 集合不存在 = 还没有反馈
    }
  }

  if (op === 'list') {
    let rows = []
    try {
      rows = await fetchAll(db, {})
    } catch (e) {
      return { ok: true, isManager: true, groups: [], total: 0 } // 集合不存在时返回空
    }
    const map = {}
    rows.forEach((r) => {
      const key = [r.signal, r.intent, r.norm].join('|')
      if (!map[key]) {
        map[key] = {
          key, signal: r.signal || '', intent: r.intent || '', norm: r.norm || '',
          count: 0, lastAt: '', status: r.status || 'pending', note: r.note || '',
          samples: [],
        }
      }
      const g = map[key]
      g.count++
      if (String(r.created_at || '') > g.lastAt) g.lastAt = String(r.created_at || '')
      if (g.samples.length < 3) {
        g.samples.push({
          question: r.question || '',
          understood: r.understood || '',
          fixed: r.fixed || '',
          reply: r.reply || '',
          at: r.created_at || '',
          reason: r.reason || '',
        })
      }
      // 组内只要有一条被标记过，就沿用该状态（最新一条为准）
      if (r.status && r.status !== 'pending') { g.status = r.status; g.note = r.note || '' }
    })
    const groups = Object.keys(map).map((k) => map[k])
      .sort((a, b) => b.count - a.count || String(b.lastAt).localeCompare(String(a.lastAt)))
    return { ok: true, isManager: true, groups, total: rows.length }
  }

  if (op === 'setStatus') {
    const signal = String((event && event.signal) || '')
    const intent = String((event && event.intent) || '')
    const norm = String((event && event.norm) || '')
    const status = ['pending', 'fixed', 'notbug', 'ignored'].indexOf(event && event.status) >= 0 ? event.status : 'pending'
    const note = short((event && event.note) || '', 200)
    try {
      await db.collection('ai_feedback')
        .where({ signal, intent, norm })
        .update({ data: { status, note } })
      return { ok: true }
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) }
    }
  }

  return { ok: false, message: '未知 op' }
}
