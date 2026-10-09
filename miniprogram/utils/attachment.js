// 附件通用工具：图片（拍照/相册，自动压缩）+ 微信聊天文件 → 上传云存储 → {fileID, name, kind} 数组。
// 被 花费编辑页(budget/edit) 与 材料编辑页(material/edit) 共用。
// 存储结构：attachments: [{ fileID, name, kind: 'image' | 'file' }]
// 说明：删除记录采用软删，附件文件保留在云存储不物理删除（可追溯、防误删）。

const MAX_ATTACHMENTS = 9

// 兼容历史数据：纯 fileID 字符串视为图片
function normalizeList(list) {
  return (list || []).map((a) =>
    typeof a === 'string' ? { fileID: a, name: '图片', kind: 'image' } : a
  )
}

// 选附件：ActionSheet 二选一 —— 「拍照/相册」(chooseMedia 压缩图) / 「微信聊天文件」(chooseMessageFile)
// 返回 [{ temp, name, kind }]，未选/取消返回 []
function choose(existingCount) {
  return new Promise((resolve) => {
    const remain = MAX_ATTACHMENTS - existingCount
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_ATTACHMENTS} 个附件`, icon: 'none' })
      return resolve([])
    }
    wx.showActionSheet({
      itemList: ['拍照 / 相册选图', '微信聊天文件'],
      success: (r) => {
        if (r.tapIndex === 0) {
          wx.chooseMedia({
            count: remain,
            mediaType: ['image'],
            sizeType: ['compressed'],
            success: (res) =>
              resolve((res.tempFiles || []).map((f) => ({ temp: f.tempFilePath, name: '', kind: 'image' }))),
            fail: () => resolve([]),
          })
        } else {
          wx.chooseMessageFile({
            count: remain,
            type: 'file',
            success: (res) =>
              resolve((res.tempFiles || []).map((f) => ({ temp: f.path, name: f.name || '文件', kind: 'file' }))),
            fail: () => resolve([]),
          })
        }
      },
      fail: () => resolve([]),
    })
  })
}

// 逐个上传到云存储 dir 目录（如 'expenses' / 'materials'），返回 {fileID, name, kind} 列表
async function upload(items, dir) {
  const out = []
  for (const it of items || []) {
    const rand = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    if (it.kind === 'image') {
      const ext = (String(it.temp).match(/\.(\w+)$/) || [null, 'jpg'])[1]
      const res = await wx.cloud.uploadFile({ cloudPath: `${dir}/${rand}.${ext}`, filePath: it.temp })
      out.push({ fileID: res.fileID, name: it.name || '图片', kind: 'image' })
    } else {
      // 文件保留原始文件名（含扩展名，openDocument 识别类型用）；过滤非法字符
      const safe = String(it.name || '文件').replace(/[\\/:*?"<>|]/g, '_')
      const res = await wx.cloud.uploadFile({ cloudPath: `${dir}/${rand}-${safe}`, filePath: it.temp })
      out.push({ fileID: res.fileID, name: safe, kind: 'file' })
    }
  }
  return out
}

// 预览图片：fileID 不支持直接 previewImage，先换临时链接
async function previewImages(fileIDs, currentFileID) {
  if (!fileIDs || !fileIDs.length) return
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: fileIDs })
    const urls = (res.fileList || []).map((f) => f.tempFileURL).filter(Boolean)
    const idx = fileIDs.indexOf(currentFileID)
    wx.previewImage({ current: urls[idx] || urls[0], urls })
  } catch (e) {
    wx.showToast({ title: '图片加载失败', icon: 'none' })
  }
}

function downloadFile(url) {
  return new Promise((resolve, reject) => wx.downloadFile({ url, success: resolve, fail: reject }))
}

// 打开非图片附件：临时链接 → 下载 → openDocument（pdf/doc/xls/ppt 等由微信识别，类型取文件扩展名）
async function openFile(fileID, name) {
  wx.showLoading({ title: '打开中…', mask: true })
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: [fileID] })
    const url = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL
    if (!url) throw new Error('取不到文件地址')
    const dl = await downloadFile(url)
    if (dl.statusCode !== 200) throw new Error('文件下载失败')
    const m = String(name || '').match(/\.(\w+)$/)
    wx.openDocument({
      filePath: dl.tempFilePath,
      fileType: m ? m[1].toLowerCase() : undefined,
      showMenu: true,
      fail: () => wx.showToast({ title: '该文件类型不支持预览', icon: 'none' }),
    })
  } catch (e) {
    wx.showToast({ title: (e && e.message) || '打开失败', icon: 'none' })
  } finally {
    wx.hideLoading()
  }
}

module.exports = { MAX_ATTACHMENTS, normalizeList, choose, upload, previewImages, openFile }
