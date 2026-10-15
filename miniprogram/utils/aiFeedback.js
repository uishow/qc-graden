// AI 管家反馈闭环客户端封装。
// 设计原则：**记录失败绝不影响主流程**（try/catch 全吞，不弹错、不打断录入）。
// 安全：ai_feedback 集合 read/write=false，读写都经 aiFeedback 云函数。
const FUNC = 'aiFeedback'

// 记录一次「AI 没帮上忙」的信号
// signal: edit_diff | cancel | unparsed | no_result | retry | degraded | thumb_down
function log(signal, payload) {
  const p = payload || {}
  try {
    wx.cloud.callFunction({
      name: FUNC,
      data: {
        op: 'log',
        signal,
        question: String(p.question || ''),
        understood: String(p.understood || ''),
        fixed: String(p.fixed || ''),
        reply: String(p.reply || ''),
        intent: String(p.intent || ''),
        reason: String(p.reason || ''),
        projectId: String(p.projectId || ''),
      },
    })
    return true
  } catch (e) {
    return false
  }
}

// 管理员拉取聚合分组（按出现次数倒序）
async function list() {
  try {
    const res = await wx.cloud.callFunction({ name: FUNC, data: { op: 'list' } })
    const r = (res && res.result) || {}
    if (!r.ok) return { data: null, error: { message: r.message || '无权查看' } }
    return { data: { groups: r.groups || [], total: r.total || 0 }, error: null }
  } catch (e) {
    return { data: null, error: { message: (e && e.errMsg) || '网络错误' } }
  }
}

// 管理员取「待处理」摘要（轻量，供「我的」页角标）
async function summary() {
  try {
    const res = await wx.cloud.callFunction({ name: FUNC, data: { op: 'summary' } })
    const r = (res && res.result) || {}
    return { data: { pendingGroups: r.pendingGroups || 0, pendingRows: r.pendingRows || 0 }, error: null }
  } catch (e) {
    return { data: { pendingGroups: 0, pendingRows: 0 }, error: null } // 角标失败不打扰用户
  }
}

// 管理员整组标记状态
async function setStatus(group, status, note) {
  try {
    const res = await wx.cloud.callFunction({
      name: FUNC,
      data: {
        op: 'setStatus',
        signal: group.signal,
        intent: group.intent,
        norm: group.norm,
        status,
        note: String(note || ''),
      },
    })
    const r = (res && res.result) || {}
    if (!r.ok) return { data: null, error: { message: r.message || '操作失败' } }
    return { data: true, error: null }
  } catch (e) {
    return { data: null, error: { message: (e && e.errMsg) || '网络错误' } }
  }
}

module.exports = { log, list, setStatus, summary }
