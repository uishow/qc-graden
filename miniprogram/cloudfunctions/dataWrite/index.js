const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 成员校验写：diaries / expenses / materials 的增删改统一走本函数。
// 客户端写之前，这里先查 members 确认「当前用户是该项目的 active 成员」，
// 不是就拒绝。配合三张表安全规则 write:false，彻底堵死绕过界面、直连数据库的越权写入
// （例如被移除的成员手机仍残留 projectId 直接 add/update）。
//
// 输入 event：
//   collection: 'diaries' | 'expenses' | 'materials'
//   op:        'insert' | 'update' | 'delete'
//   projectId: 目标项目 id（成员归属判据）
//   id:        update/delete 时的文档 _id
//   data:      insert/update 的字段对象
//   version:   （可选）update 时的乐观锁旧版本号；命中才更新，否则返回 CONFLICT
//
// 返回：{ ok, data, error } —— 与前端 utils/write.js 约定一致。
//   insert 成功 data=[{ id, _id }]；update 成功 data={ stats }；delete 成功 data=null。

const ALLOWED = ['diaries', 'expenses', 'materials']

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, code: 'NO_AUTH', error: { code: 'NO_AUTH', message: '未登录' } }

  const collection = event.collection
  const op = event.op
  const projectId = event.projectId
  if (!ALLOWED.includes(collection))
    return { ok: false, code: 'BAD_COLLECTION', error: { code: 'BAD_COLLECTION', message: '不允许的集合' } }
  if (!['insert', 'update', 'delete'].includes(op))
    return { ok: false, code: 'BAD_OP', error: { code: 'BAD_OP', message: '不支持的操作' } }
  if (!projectId)
    return { ok: false, code: 'BAD_PROJECT', error: { code: 'BAD_PROJECT', message: '缺少 projectId' } }

  const db = cloud.database()

  // 成员校验：必须是该项目 active 成员（owner/family/member），否则拒绝。
  // 被移除成员在 members 无记录（projectAdmin.removeMember 直接删行）→ 这里查不到 → 拒绝。
  const mRes = await db
    .collection('members')
    .where({ project_id: projectId, user_id: OPENID, status: 'active' })
    .limit(1)
    .get()
  if (!mRes.data || mRes.data.length === 0) {
    return {
      ok: false,
      code: 'NO_MEMBER',
      error: { code: 'NO_MEMBER', message: '你不是该项目的成员，没有修改权限' },
    }
  }

  try {
    if (op === 'insert') {
      const data = Object.assign({}, event.data || {})
      // 强制归属当前项目，防止客户端把内容写进别的项目
      data.project_id = projectId
      const res = await db.collection(collection).add({ data })
      const id = res && (res._id || (res.data && res.data._id))
      return { ok: true, data: [{ id, _id: id }], error: null }
    }

    if (op === 'update') {
      const id = event.id
      if (!id) return { ok: false, code: 'BAD_ID', error: { code: 'BAD_ID', message: '缺少 id' } }
      const where = { _id: id, project_id: projectId }
      // 仅在调用方传了旧版本号时才加乐观锁；不传则按 id 直接更新（兼容无 version 的老数据）
      if (event.version !== undefined && event.version !== null) where.version = event.version
      const res = await db.collection(collection).where(where).update({ data: event.data || {} })
      if (res.stats && res.stats.updated === 0) {
        return {
          ok: false,
          code: 'CONFLICT',
          error: { code: 'CONFLICT', message: '数据已被其他人修改，请刷新后重试' },
        }
      }
      return { ok: true, data: { stats: res.stats }, error: null }
    }

    if (op === 'delete') {
      const id = event.id
      if (!id) return { ok: false, code: 'BAD_ID', error: { code: 'BAD_ID', message: '缺少 id' } }
      await db.collection(collection).where({ _id: id, project_id: projectId }).remove()
      return { ok: true, data: null, error: null }
    }
  } catch (e) {
    return {
      ok: false,
      code: 'WRITE_FAILED',
      error: { code: 'WRITE_FAILED', message: (e && e.message) || '写入失败' },
    }
  }
}
