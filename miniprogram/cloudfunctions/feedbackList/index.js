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
      const r = await col.order('created_at', { ascending: false }).limit(100).get()
      rows = r.data || []
    } else {
      // self 视图：先按业务字段 openid 查，0 条时再按云开发自动加的 _openid 查一次取并集
      // 背景：2026-10-15 用户场景是云端有数据但 list=[]，怀疑字段名（业务 openid vs 系统 _openid）
      //   或 openid 值在不同端不一致；取两次能最大限度兜底
      const r1 = await col.where({ openid }).order('created_at', { ascending: false }).limit(100).get()
      rows = r1.data || []
      if (rows.length === 0) {
        const r2 = await col.where({ _openid: openid }).order('created_at', { ascending: false }).limit(100).get()
        rows = r2.data || []
        console.log('[feedbackList] self fallback to _openid, hitCount:', rows.length)
      }
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

  // 投影成前端更易用的字段（含 openid 长度简写：普通用户只看自己，all 时显示「OpenID 后 4 位」做简单区分）
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
    // 隐藏手机端 openid 全串：仅显示尾 4 位，避免泄漏
    openidTail: r.openid ? String(r.openid).slice(-4) : '????',
  }))

  return { ok: true, isManager: mgr, scope, list }
}
