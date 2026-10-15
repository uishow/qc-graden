// 时间格式化（统一 UTC+8，本地时间）
// 背景：数据库的 created_at / updated_at 都是 `new Date().toISOString()` 写入，
//       toISOString 永远输出 UTC 串（YYYY-MM-DDTHH:mm:ss.sssZ）。
//       之前各页面的 slice(0,16).replace('T',' ') 是直接截 UTC 串，
//       中国用户看到的是 UTC 时间（差 8 小时），会让用户觉得「时间不对」。
// 修法：所有时间显示统一走本工具，强制 +8h 转本地。
// 为什么不依赖 toLocaleString：部分平台（如 HarmonyOS 微信）默认时区可能不准确，
//       项目所在地是北京，统一 UTC+8 最稳。

const TZ_OFFSET_MS = 8 * 3600 * 1000
const pad2 = (n) => (n < 10 ? '0' + n : '' + n)

/**
 * 把 ISO 时间字符串（或 Date）按 UTC+8 格式化为本地时间。
 * @param {string|Date|number} iso ISO 字符串 / Date / 毫秒数
 * @param {string} [format] 输出格式：
 *                        'datetime' (默认) → 'YYYY-MM-DD HH:mm'
 *                        'date'             → 'YYYY-MM-DD'
 *                        'time'             → 'HH:mm'
 *                        'short'            → 'MM-DD HH:mm'
 * @returns {string} 格式化后的时间；输入空/解析失败时按 format 长度兜底为 '—' 或 ''
 */
function formatLocal(iso, format) {
  format = format || 'datetime'
  const s = String(iso == null ? '' : iso).trim()
  if (!s) return format === 'date' ? '' : '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) {
    // 解析失败：兜底用字符串截取，保留时区原始形态（避免错误"修"成对的时间）
    if (format === 'date') return s.slice(0, 10) || ''
    if (format === 'time') return (s.match(/T(\d{2}:\d{2})/) || [, ''])[1] || ''
    return s.slice(0, 16).replace('T', ' ') || s.slice(0, 16) || '—'
  }
  const t = new Date(d.getTime() + TZ_OFFSET_MS)
  const Y = t.getUTCFullYear()
  const M = pad2(t.getUTCMonth() + 1)
  const D = pad2(t.getUTCDate())
  const h = pad2(t.getUTCHours())
  const m = pad2(t.getUTCMinutes())
  if (format === 'date') return Y + '-' + M + '-' + D
  if (format === 'time') return h + ':' + m
  if (format === 'short') return M + '-' + D + ' ' + h + ':' + m
  return Y + '-' + M + '-' + D + ' ' + h + ':' + m
}

// 兼容旧 API：单独导出「时分」格式（部分页面想直接拿到 HH:mm）
function formatTime(iso) {
  return formatLocal(iso, 'time')
}

module.exports = { formatLocal, formatTime }
