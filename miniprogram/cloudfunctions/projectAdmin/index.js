const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 项目管理（管理员上下文，绕过 members/projects 写安全规则）。
// 客户端：wx.cloud.callFunction({ name:'projectAdmin', data:{ action, projectId, ... } })
//   action:
//     'regenCode'  { type:'family'|'member' }                 → 重置对应邀请码，返回新 code
//     'removeMember' { memberId }                             → 管理员移除某成员（不能移除项目创建者）
//     'exit'                                                 → 自己退出项目
//     'deleteProject'                                        → 创建者删除项目（级联清理关联数据）
//
// 权限：regenCode / removeMember 要求调用者 role ∈ {owner, family}；
//       deleteProject 仅 owner；exit 任意成员本人。

function gen6() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '未登录' }
  const { action, projectId } = event || {}
  if (!action) return { ok: false, message: '缺少 action' }
  if (!projectId) return { ok: false, message: '缺少 projectId' }

  const db = cloud.database()
  const _ = db.command

  // 调用者在该项目的角色
  const meRes = await db
    .collection('members')
    .where({ project_id: projectId, user_id: OPENID, status: 'active' })
    .limit(1)
    .get()
  const me = meRes.data && meRes.data[0]
  const myRole = me && me.role

  if (action === 'exit') {
    if (!me) return { ok: false, message: '你不是该项目成员' }
    await db.collection('members').where({ project_id: projectId, user_id: OPENID }).remove()
    return { ok: true }
  }

  // 以下操作需管理员（owner / family）
  if (myRole !== 'owner' && myRole !== 'family') {
    return { ok: false, message: '无权限（仅管理员可操作）' }
  }

  if (action === 'regenCode') {
    const type = event.type === 'member' ? 'member' : 'family'
    const field = type === 'member' ? 'invite_code_member' : 'invite_code_family'
    const otherField = type === 'member' ? 'invite_code_family' : 'invite_code_member'
    const projRes = await db.collection('projects').doc(projectId).get()
    const other = projRes.data && projRes.data[otherField]
    let code = gen6()
    let guard = 0
    while (other && code === other && guard < 20) {
      code = gen6()
      guard++
    }
    await db.collection('projects').doc(projectId).update({ data: { [field]: code, code_updated_at: new Date() } })
    return { ok: true, type, code }
  }

  if (action === 'removeMember') {
    const memberId = event.memberId
    if (!memberId) return { ok: false, message: '缺少 memberId' }
    const target = await db.collection('members').doc(memberId).get()
    if (!target.data) return { ok: false, message: '成员不存在' }
    if (target.data.project_id !== projectId) return { ok: false, message: '成员不属于该项目' }
    if (target.data.role === 'owner') return { ok: false, message: '不能移除项目创建者' }
    await db.collection('members').doc(memberId).remove()
    return { ok: true }
  }

  if (action === 'deleteProject') {
    if (myRole !== 'owner') return { ok: false, message: '仅项目创建者可删除' }
    // 级联清理：先删关联集合，再删项目本身
    const cols = ['members', 'stages', 'rooms', 'diaries', 'expenses', 'materials', 'knowledge_articles']
    for (const c of cols) {
      // 分批删除，避免单次上限；云函数端 remove 按 where 全删
      await db.collection(c).where({ project_id: projectId }).remove()
    }
    await db.collection('projects').doc(projectId).remove()
    return { ok: true }
  }

  return { ok: false, message: '未知 action' }
}
