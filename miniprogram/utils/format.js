// 展示格式化：金额分→元、日期
function fen2yuan(fen, withSymbol) {
  const n = (Number(fen || 0) / 100).toFixed(2)
  return (withSymbol === false ? '' : '¥') + n.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function yuan2fen(yuan) {
  // 兼容 fen2yuan 产生的千分位逗号（如 "1,234.00"）：先去掉逗号再转数字，
  // 否则 Number("1,234.00") 为 NaN → 0，会让 onSave 的「fen <= 0」误判而拦截保存。
  const cleaned = String(yuan == null ? '' : yuan).replace(/,/g, '').trim()
  const n = Math.round(Number(cleaned || 0) * 100)
  return Number.isFinite(n) ? n : 0
}

function today() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function shortDate(iso) {
  if (!iso) return ''
  return String(iso).slice(0, 10)
}

function unwrap({ data, error }) {
  if (error) throw error
  return data
}

module.exports = { fen2yuan, yuan2fen, today, shortDate, unwrap }
