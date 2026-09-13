/**
 * Bindview DevTools · 工具栏弹出面板
 * 通过 runtime 消息向 Service Worker 查询当前标签页的检测结果
 */
(function () {
  'use strict'

  var statusEl = document.getElementById('status')
  var dotEl = document.getElementById('dot')
  var statusTextEl = document.getElementById('statusText')
  var countEl = document.getElementById('count')
  var hintEl = document.getElementById('hint')
  var versionEl = document.getElementById('version')

  try {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version
  } catch (e) {
    versionEl.textContent = ''
  }

  function render(count) {
    var n = typeof count === 'number' && count > 0 ? count : 0
    var detected = n > 0

    dotEl.classList.toggle('dot--on', detected)
    statusEl.style.color = detected ? 'var(--accent)' : ''
    statusTextEl.textContent = detected ? '已检测到 bindview 应用' : '未检测到 bindview 应用'
    countEl.textContent = detected ? n + ' 个' : '—'
    hintEl.textContent = detected
      ? '按 F12 打开开发者工具,切换到「Bindview」面板查看组件树、状态与路由。'
      : '当前页面没有检测到 bindview 应用;若确实是 bindview 应用,请刷新页面后重试。'
  }

  render(0)

  try {
    chrome.runtime.sendMessage({ type: 'popup:getState' }, function (res) {
      void chrome.runtime.lastError
      render(res && res.count)
    })
  } catch (e) {
    hintEl.textContent = '无法连接后台,请重新加载扩展后重试。'
  }
})()
