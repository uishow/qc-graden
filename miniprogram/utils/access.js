// 成员/授权查询助手：把「我加入了哪些项目、是什么角色」集中在此，
// 供首页、我的、知识库等页面复用「成员隔离」逻辑（替代旧的全员可见模式）。
//
// members 表字段：project_id, user_id(=openid), role('owner'|'family'|'member'), status('active'|'left')
// 注意：user_id 存的是 openid 字符串，与 cloud.auth 拿到的 user.id 一致。

const { cloud } = require('./cloud')

// 我加入的全部 active 成员记录
async function myMembers(openid) {
  if (!openid) return []
  const { data, error } = await cloud.database
    .from('members')
    .select('project_id,role,status,joined_at')
    .eq('user_id', openid)
    .eq('status', 'active')
    .limit(50)
  if (error || !data) return []
  return data
}

// 我加入的项目 id 列表
async function myProjectIds(openid) {
  const list = await myMembers(openid)
  return list.map((m) => m.project_id)
}

// 我在某项目的角色（无则返回 null）
async function myRole(openid, projectId) {
  if (!openid || !projectId) return null
  const list = await myMembers(openid)
  const m = list.find((x) => x.project_id === projectId)
  return m ? m.role : null
}

// 角色 → 中文标签
function roleLabel(role) {
  return { owner: '管理员', family: '家庭成员', member: '协作成员' }[role] || '成员'
}

// 是否管理员（可管理成员/邀请码）
function isManager(role) {
  return role === 'owner' || role === 'family'
}

module.exports = { myMembers, myProjectIds, myRole, roleLabel, isManager }
