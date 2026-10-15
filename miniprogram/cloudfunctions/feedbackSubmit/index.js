const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// APP 评价与意见收集：
// - 客户端只负责表单采集，所有写入经本云函数（app_feedback 安全规则 write=false）
// - 集合不存在时自动创建，避免首次提交失败
// - 字段：维度评分（三维 1-5 分）+ 自由意见 + 客户端版本/平台/系统信息，便于后续归因
// - 不限制 openid：任何登录用户均可提交（这是面向自家产品的反馈渠道）

async function ensureCollection(db, name) {
  try { await db.createCollection(name) } catch (e) { /* 已存在 */ }
}

function cleanScore(v) {
  // 评分只接受 1-5 整数；非数字/越界视为 0（表示未评）
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (n < 1 || n > 5) return 0
  return Math.round(n)
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return { ok: false, message: '未登录' }

  const { scores, comment, app_version, platform, system } = event || {}
  // 三维评分清洗
  const safeScores = {
    usability: cleanScore(scores && scores.usability),
    aesthetics: cleanScore(scores && scores.aesthetics),
    functionality: cleanScore(scores && scores.functionality),
  }
  const anyRated = safeScores.usability || safeScores.aesthetics || safeScores.functionality
  const text = String(comment == null ? '' : comment).trim().slice(0, 1000) // 1000 字上限，防刷

  if (!anyRated && !text) {
    return { ok: false, message: '请至少打一项分或填写意见' }
  }

  const now = new Date().toISOString()
  const row = {
    openid,
    scores: safeScores,
    comment: text,
    app_version: String(app_version || '').slice(0, 40),
    platform: String(platform || '').slice(0, 20),
    system: String(system || '').slice(0, 60),
    created_at: now,
  }

  const db = cloud.database()
  try {
    // ★ 2026-10-15 诊断日志：写之前打 event 实际收到的字段，
    //   排查「客户端 UI 显示 4 分但云端存 0 分」是不是嵌套对象在 HarmonyOS 平台被吞字段
    console.log('[feedbackSubmit] event received:', JSON.stringify(event || {}))
    await db.collection('app_feedback').add({ data: row })
    return { ok: true, _debug: { wroteScores: safeScores, wroteOpenid: openid } }
  } catch (e) {
    // 集合不存在：自动创建后重试一次（仅首次需要）
    try {
      await ensureCollection(db, 'app_feedback')
      await db.collection('app_feedback').add({ data: row })
      return { ok: true, _debug: { wroteScores: safeScores, wroteOpenid: openid, afterCreate: true } }
    } catch (e2) {
      console.error('[feedbackSubmit] write failed:', e2)
      return { ok: false, message: '提交失败：' + ((e2 && e2.message) || e2) }
    }
  }
}
