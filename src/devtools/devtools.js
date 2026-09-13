/**
 * Bindview DevTools · 面板注册
 * ------------------------------------------------------------------
 * devtools_page 在打开开发者工具时加载,这里向 DevTools 注册一个名为
 * "Bindview" 的面板,面板内容由 src/panel/index.html 提供。
 */
chrome.devtools.panels.create(
  'Bindview',
  'assets/icons/icon48.png',
  'src/panel/index.html',
  function (panel) {
    panel.onShown.addListener(function () {
      // 面板显示时通知页面后端补发快照(避免错过事件)
      var tabId = chrome.devtools.inspectedWindow.tabId
      try {
        var port = chrome.runtime.connect({ name: 'bindview-devtools-panel' })
        port.postMessage({ type: 'panel:init', tabId: tabId })
        port.postMessage({ type: 'panel:refresh' })
        // 读取 lastError,避免端口在页面 bfcache / SW 休眠时被关闭却未处理
        void chrome.runtime.lastError
        setTimeout(function () {
          try {
            port.disconnect()
            void chrome.runtime.lastError
          } catch (e) { void chrome.runtime.lastError }
        }, 300)
      } catch (e) {
        void chrome.runtime.lastError
        /* DevTools 未连接时忽略 */
      }
    })
  }
)
