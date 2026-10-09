const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 静默登录：返回调用方 OPENID，并 upsert profiles（owner_id = openid）。
// 客户端在 app.js ensureLogin 中调用；后续所有写操作以 openid 作为 user_id/owner_id。
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { openid: null, error: 'no openid' }
  }
  const db = cloud.database()
  const profiles = db.collection('profiles')
  const existing = await profiles.where({ owner_id: OPENID }).get()
  if (!existing.data.length) {
    // 注意：wx-server-sdk 服务端 add 必须包 { data: obj }，裸 add(obj) 会静默失败（已踩坑，init 同修）
    await profiles.add({ data: { owner_id: OPENID, nick_name: '我', created_at: new Date() } })
  }
  return { openid: OPENID }
}
