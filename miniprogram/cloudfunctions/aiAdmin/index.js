const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// LLM 集中配置管理：app_settings 集合（key='llm'）存 base_url/api_key/model。
// 权限：仅「家庭成员」(members.role ∈ owner/family) 可读写；api_key 只下发尾 4 位。
// 首次保存时自动创建 app_settings 集合（管理员上下文，不受安全规则限制）。
// 注意：app_settings 安全规则 read=false——密钥对客户端完全不可见，读取只经本函数。

async function isManager(db, openid) {
  const r = await db.collection('members').where({ user_id: openid }).limit(50).get()
  return (r.data || []).some((x) => x.role === 'owner' || x.role === 'family')
}

async function ensureCollection(db) {
  try { await db.createCollection('app_settings') } catch (e) { /* 已存在会抛错，忽略 */ }
}

exports.main = async (event) => {
  const { action, base_url, api_key, model } = event || {}
  const db = cloud.database()
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return { ok: false, message: '未登录' }

  let manager = false
  try { manager = await isManager(db, openid) } catch (e) { manager = false }
  if (!manager) return { ok: false, message: '仅家庭成员（owner/family）可配置 AI' }

  if (action === 'get') {
    try {
      const r = await db.collection('app_settings').where({ key: 'llm' }).limit(1).get()
      const d = r.data && r.data[0]
      if (d) {
        return {
          ok: true,
          configured: true,
          base_url: d.base_url || '',
          model: d.model || '',
          keyTail: String(d.api_key || '').slice(-4), // 密钥只回显尾 4 位
        }
      }
      return { ok: true, configured: false }
    } catch (e) {
      return { ok: true, configured: false } // 集合不存在等 → 视为未配置
    }
  }

  if (action === 'save') {
    const baseUrl = String(base_url || '').trim()
    const mdl = String(model || 'deepseek-chat').trim()
    const key = String(api_key || '').trim()
    if (!baseUrl || !mdl) return { ok: false, message: '接口地址与模型名必填' }
    const now = new Date().toISOString()
    try {
      const r = await db.collection('app_settings').where({ key: 'llm' }).limit(1).get()
      if (r.data && r.data[0]) {
        const patch = { base_url: baseUrl, model: mdl, updated_at: now }
        if (key) patch.api_key = key // 留空 = 不修改已有密钥
        await db.collection('app_settings').doc(r.data[0]._id).update({ data: patch })
        return { ok: true }
      }
      if (!key) return { ok: false, message: '首次配置需填写 API Key' }
      await db.collection('app_settings').add({ data: { key: 'llm', base_url: baseUrl, api_key: key, model: mdl, updated_at: now } })
      return { ok: true }
    } catch (e) {
      // 集合可能尚不存在：创建后重试一次
      try {
        await ensureCollection(db)
        if (!key) return { ok: false, message: '首次配置需填写 API Key' }
        await db.collection('app_settings').add({ data: { key: 'llm', base_url: baseUrl, api_key: key, model: mdl, updated_at: now } })
        return { ok: true }
      } catch (e2) {
        return { ok: false, message: '保存失败：' + ((e2 && e2.message) || e2) }
      }
    }
  }

  return { ok: false, message: '未知操作' }
}
