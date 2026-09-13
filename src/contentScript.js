/**
 * Bindview DevTools · 内容脚本(MV3 / ISOLATED world)
 * ------------------------------------------------------------------
 * 仅承担「页面 ↔ 扩展」的消息中转,不包含任何业务逻辑:
 *
 *   页面(MAIN)  --window.postMessage-->  内容脚本  --runtime.sendMessage-->  后台  -->  面板
 *   页面(MAIN)  <--window.postMessage--  内容脚本  <--runtime.onMessage----  后台  <--  面板
 *
 * 为什么**不使用长连接 Port**:
 *   页面一旦持有扩展 Port,进入 bfcache 时 Chrome 会强制关闭该 Port,并产生
 *   "The page keeping the extension port is moved into back/forward cache,
 *    so the message channel is closed." 的 Unchecked runtime.lastError(归属本文件)。
 *   改用一次性消息(runtime.sendMessage / runtime.onMessage)后,页面不再持有任何
 *   Port,从根本上规避该错误,同时天然兼容 bfcache 往返。
 */
(function () {
  'use strict'

  if (window.__BINDVIEW_DEVTOOLS_CONTENT_LOADED__) return
  window.__BINDVIEW_DEVTOOLS_CONTENT_LOADED__ = true

  var SOURCE = 'bindview-devtools'

  /** 扩展(面板)→ 页面 */
  chrome.runtime.onMessage.addListener(function (msg) {
    // 读取并消费 lastError,避免出现 Unchecked runtime.lastError
    void chrome.runtime.lastError
    window.postMessage({ source: SOURCE, direction: 'to-page', payload: msg }, '*')
  })

  /** 页面 → 扩展(后台)。一次性消息,失败(后台未就绪 / 扩展重载)时仅忽略 */
  function sendToExtension(payload) {
    try {
      chrome.runtime.sendMessage(payload, function () {
        void chrome.runtime.lastError
      })
    } catch (e) {
      void chrome.runtime.lastError
    }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return
    var data = ev.data
    if (!data || data.source !== SOURCE || data.direction !== 'to-extension') return
    sendToExtension(data.payload)
  })

  // 告知后台:本页内容脚本已就绪(替代原 Port 连接事件,供面板握手 / 徽标检测使用)
  sendToExtension({ type: 'content:connected' })
})()
