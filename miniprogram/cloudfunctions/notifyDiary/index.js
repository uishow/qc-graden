const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 家人新日记订阅提醒（方案A）：日记创建成功后由前端调用。
//   客户端：wx.cloud.callFunction({ name:'notifyDiary', data:{ diaryId } })
// 给项目内除作者外的 active 成员逐个 subscribeMessage.send；
// 未订阅(43101)/单发失败只跳过该成员，不影响整体返回。
// 模板字段：thing1=日志作者  thing2=日志内容  time3=发布时间  thing5=备注
// 注意：thing 类型限 20 字（超长会 47003），统一截断；page 不能以 / 开头。
const TEMPLATE_ID = 'd7KlYUn-ZiAtiSr3kuRkiD2qYbYygi0T_6kLxYTMMTk'

function cut20(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim()
  return s.length > 20 ? s.slice(0, 19) + '…' : s
}

exports.main = async (event) => {
  const { diaryId } = event || {}
  if (!diaryId) return { ok: false, message: '缺少 diaryId' }
  const db = cloud.database()
  try {
    const dRes = await db.collection('diaries').doc(diaryId).get()
    const d = dRes.data
    if (!d) return { ok: false, message: '日记不存在' }

    const [memRes, profRes, projRes] = await Promise.all([
      db.collection('members').where({ project_id: d.project_id, status: 'active' }).limit(50).get(),
      db.collection('profiles').where({ owner_id: d.last_editor_id }).limit(1).get(),
      db.collection('projects').doc(d.project_id).get().catch(() => ({ data: null })),
    ])
    const authorName = (profRes.data && profRes.data[0] && profRes.data[0].nick_name) || '家人'
    const projName = (projRes.data && projRes.data.name) || ''
    const timeStr = String(d.created_at || '').slice(0, 16).replace('T', ' ') || String(d.diary_date || '')

    const targets = (memRes.data || []).filter((m) => m.user_id && m.user_id !== d.last_editor_id)
    let sent = 0
    let skipped = 0
    for (const m of targets) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: m.user_id,
          templateId: TEMPLATE_ID,
          page: 'pages/diary/detail?id=' + diaryId,
          data: {
            thing1: { value: cut20(authorName) },
            thing2: { value: cut20(d.title || d.content) },
            time3: { value: cut20(timeStr) },
            thing5: { value: cut20(projName ? '来自「' + projName + '」' : '来自装修日记本') },
          },
        })
        sent++
      } catch (e) {
        skipped++ // 常见：43101 用户未订阅/已拒绝，静默跳过
      }
    }
    return { ok: true, sent, skipped, targets: targets.length }
  } catch (e) {
    return { ok: false, message: (e && e.message) || '发送失败' }
  }
}
