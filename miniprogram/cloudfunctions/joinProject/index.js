const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 邀请码加入项目（管理员上下文，绕过写安全规则）。
// 客户端：wx.cloud.callFunction({ name:'joinProject', data:{ code } })
//   code: 6 位数字邀请码（projects.invite_code_family / invite_code_member）
// 返回：{ ok, project:{id,name}, role } | { ok:false, message }
//
// 逻辑：
//   1. 校验码匹配某项目的 family 码或 member 码；
//   2. 命中即判定加入后的角色（family 码→'family'，member 码→'member'）；
//   3. 若已是该项目 active 成员 → 报错（避免重复插入）；
//   4. 插入 members(project_id, user_id=openid, role, status:'active')。

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '未登录' }
  const code = String((event && event.code) || '').trim()
  if (!/^\d{6}$/.test(code)) return { ok: false, message: '邀请码格式不正确（应为 6 位数字）' }

  const db = cloud.database()
  const _ = db.command

  // 同一项目两种码不会相等；用 or 一次查出匹配项目
  const projRes = await db
    .collection('projects')
    .where(_.or([{ invite_code_family: code }, { invite_code_member: code }]))
    .limit(1)
    .get()
  const proj = projRes.data && projRes.data[0]
  if (!proj) return { ok: false, message: '邀请码无效或已失效' }

  const role = proj.invite_code_family === code ? 'family' : 'member'

  // 是否已加入（含任意状态，避免历史 rejected 重复插入造成歧义）
  const exist = await db
    .collection('members')
    .where({ project_id: proj._id, user_id: OPENID })
    .limit(1)
    .get()
  if (exist.data && exist.data.length) {
    // 若之前是退出(rejected)状态，重新加入则恢复 active
    const prev = exist.data[0]
    if (prev.status !== 'active') {
      await db.collection('members').doc(prev._id).update({ data: { status: 'active', role, joined_at: new Date() } })
    }
    return { ok: true, already: true, project: { id: proj._id, name: proj.name }, role }
  }

  await db.collection('members').add({
    data: {
      project_id: proj._id,
      user_id: OPENID,
      role,
      status: 'active',
      joined_at: new Date(),
    },
  })
  return { ok: true, project: { id: proj._id, name: proj.name }, role }
}
