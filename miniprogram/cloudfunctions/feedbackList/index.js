const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// V1.0 反馈历史查询：和 feedbackSubmit 配套（安全规则 read/write=false → 必须经本函数读库）
// 权限：
//   scope 缺省或 'self'：当前用户只能看自己 openid 的反馈（任意登录用户）
//   scope = 'all'：仅 family/owner 可拉全员（普通 member 仍只看自己，scope 强制回落为 self）
async function isManager(db, openid) {
  const r = await db.collection('members').where({ user_id: openid }).limit(50).get()
  return (r.data || []).some((x) => x.role === 'owner' || x.role === 'family')
}

function short(text, n) {
  const s = String(text == null ? '' : text)
  return s.length > n ? s.slice(0, n) + '…' : s
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return { ok: false, message: '未登录' }

  const db = cloud.database()
  let mgr = false
  try { mgr = await isManager(db, openid) } catch (e) { mgr = false }

  const requested = (event && event.scope === 'all') ? 'all' : 'self'
  const scope = (requested === 'all' && mgr) ? 'all' : 'self' // 非管理员无权跨用户看

  let rows = []
  try {
    const col = db.collection('app_feedback')
    if (scope === 'all') {
      // 不用 .order()：当前 wx-server-sdk 报 'col.where().order is not a function'
      //   改拉全表 + JS 端 sort（项目内最多几十条，无性能问题）
      const r = await col.where({}).limit(100).get()
      rows = (r.data || []).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    } else {
      // self 视图：先按业务字段 openid 查，0 条时再按云开发自动加的 _openid 查一次取并集
      // 同样不调 .order()，拉全后 JS 端 sort
      const r1 = await col.where({ openid }).limit(100).get()
      rows = (r1.data || [])
      if (rows.length === 0) {
        const r2 = await col.where({ _openid: openid }).limit(100).get()
        rows = r2.data || []
        console.log('[feedbackList] self fallback to _openid, hitCount:', rows.length)
      }
      rows = rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    }
    // ★ 2026-10-15 诊断：打出当前查询条件 + 命中行数 + 前 1 行的 openid 比对
    console.log('[feedbackList] query', JSON.stringify({
      wxOpenid: openid,
      scope, requested,
      mgr, hitCount: rows.length,
      firstHitOpenid: rows[0] && rows[0].openid,
      firstHit_idOpenid: rows[0] && rows[0]._openid,
    }))
  } catch (e) {
    // 集合不存在/无读权限：兜底返回空（首条反馈提交时集合才会被创建）
    console.error('[feedbackList] query failed:', e)
    return { ok: true, isManager: mgr, scope, list: [] }
  }

  // ★ 批量查 profiles 拿昵称（all 视图要展示「是谁提交的」，openid 尾 4 位不直观）
  //   profiles 安全规则为服务端独占（read=false），这里用云函数管理员上下文读
  let nickMap = {}
  try {
    const openids = Array.from(new Set(rows.map((r) => r.openid).filter(Boolean)))
    if (openids.length) {
      // .in 是 db.command 的方法，老 SDK 写法；用 db.command.in 更稳
      const _ = cloud.database().command // 提前拿一份
      const pr = await cloud.database().collection('profiles')
        .where({ owner_id: _.in(openids) })
        .limit(200)
        .get()
      ;(pr.data || []).forEach((p) => { if (p.owner_id) nickMap[p.owner_id] = String(p.nick_name || '').trim() })
    }
  } catch (e) { /* profiles 集合无数据/无读权限时忽略，回落 openid 尾 4 位 */ }

  // 投影成前端更易用的字段（含 openid 长度简写：普通用户只看自己，all 时显示「昵称」做简单区分）
  const list = rows.map((r) => ({
    id: r._id || r.id,
    openid: r.openid || '',
    submittedAt: r.created_at || '',
    scores: {
      usability: Number((r.scores && r.scores.usability) || 0),
      aesthetics: Number((r.scores && r.scores.aesthetics) || 0),
      functionality: Number((r.scores && r.scores.functionality) || 0),
    },
    comment: short(r.comment, 200),
    app_version: r.app_version || '',
    system: r.system || '',
    nickName: nickMap[r.openid] || '', // 优先用昵称（all 视图展示用）
    // 兜底：没昵称时显示 openid 尾 4 位
    openidTail: r.openid ? String(r.openid).slice(-4) : '????',
  }))

  return { ok: true, isManager: mgr, scope, list }
}
