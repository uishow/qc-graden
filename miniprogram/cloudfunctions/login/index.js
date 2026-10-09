const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 静默登录：返回调用方 OPENID，并 upsert profiles（owner_id = openid）。
// 客户端在 app.js ensureLogin 中调用；后续所有写操作以 openid 作为 user_id/owner_id。
//
// profiles 集合为「所有人可读、仅服务端可写」，故昵称修改也走本函数：
//   event.setNick 传入合法昵称（1-12 字）→ 更新调用者自己的昵称（只能改自己的，安全）。
// 默认昵称存空字符串：前端兜底显示「成员·openid尾4」。曾默认存「我」，导致所有新用户
// 在他人列表里都叫「我」，故登录时对历史「我」昵称做一次性自愈清空。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { openid: null, error: 'no openid' }
  }
  const db = cloud.database()
  const profiles = db.collection('profiles')
  const existing = await profiles.where({ owner_id: OPENID }).get()
  const doc = existing.data && existing.data[0]

  // 自助改名：只允许改自己的昵称
  const nick = String((event && event.setNick) || '').trim()
  if (nick) {
    if (nick.length > 12) {
      return { openid: OPENID, ok: false, error: '昵称最长 12 个字' }
    }
    // 注意：wx-server-sdk 服务端 add 必须包 { data: obj }，裸 add(obj) 会静默失败（已踩坑）
    if (doc) {
      await profiles.doc(doc._id).update({ data: { nick_name: nick, updated_at: new Date() } })
    } else {
      await profiles.add({ data: { owner_id: OPENID, nick_name: nick, created_at: new Date() } })
    }
    return { openid: OPENID, ok: true, nick }
  }

  if (!doc) {
    await profiles.add({ data: { owner_id: OPENID, nick_name: '', created_at: new Date() } })
  } else if (doc.nick_name === '我') {
    // 自愈旧数据：历史默认昵称「我」清空，显示走前端兜底「成员·尾4」
    await profiles.doc(doc._id).update({ data: { nick_name: '', updated_at: new Date() } })
  }
  return { openid: OPENID }
}
