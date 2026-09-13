/**
 * Bindview DevTools · 背景 Service Worker(MV3)
 * ------------------------------------------------------------------
 * 负责在 DevTools 面板与页面内容脚本之间做消息路由:
 *   - 面板通过名为 `bindview-devtools-panel` 的 Port 连接,并上报 inspectedWindow.tabId
 *   - 页面侧内容脚本使用**一次性消息**(runtime.sendMessage / tabs.sendMessage),
 *     页面不再持有 Port,从根本上避免「页面进入 bfcache → 扩展 Port 被关闭」
 *     所导致的 Unchecked runtime.lastError
 *   - 本模块按 tabId 维护面板 Port 集合,并记录「内容脚本已就绪」的标签页
 */
'use strict'

var PANEL_PORT = 'bindview-devtools-panel'

/** tabId -> Set<Port>(面板长连接;面板运行在 DevTools 页面,不受 bfcache 影响) */
var panelPorts = new Map()
/** 内容脚本已就绪的 tabId 集合 */
var contentTabs = new Set()
/** tabId -> 检测到的组件数量(0 表示未检测到 bindview 应用) */
var tabCounts = new Map()
/** 当前激活标签页 id:工具栏图标只反映激活标签页的检测结果 */
var activeTabId = null

function getPanelSet(tabId) {
  var set = panelPorts.get(tabId)
  if (!set) {
    set = new Set()
    panelPorts.set(tabId, set)
  }
  return set
}

function toPanels(tabId, message) {
  var set = panelPorts.get(tabId)
  if (!set) return
  set.forEach(function (port) {
    try {
      port.postMessage(message)
      void chrome.runtime.lastError
    } catch (e) {
      void chrome.runtime.lastError
      /* 连接已断开,由 onDisconnect 清理 */
    }
  })
}

/**
 * 向页面内容脚本发送一条消息(一次性消息,页面不持有 Port)
 * 失败(页面未注入 / 已卸载 / 广播不可达)时通过 lastError 回调静默忽略
 * @param {Number} tabId
 * @param {Object} message
 * @returns {Boolean} 是否已尝试发送
 */
function toContent(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, function () {
      void chrome.runtime.lastError
    })
    return true
  } catch (e) {
    void chrome.runtime.lastError
    return false
  }
}

/** 检测到 bindview 应用:品牌绿色徽标 */
var BADGE_ON_COLOR = '#41b883'

/**
 * 记录某标签页的检测结果;若它正是当前激活标签页,则立即刷新工具栏徽标。
 *
 * 说明:工具栏**图标固定为彩色 logo**(manifest 的 `action.default_icon`),
 *       不随检测结果切换灰/彩;检测结果只通过**徽标(组件数量)**体现。
 *
 * @param {Number} tabId
 * @param {Number} count 组件数量(0 / 非数字 表示未检测到)
 */
function setDetectState(tabId, count) {
  var n = typeof count === 'number' && count > 0 ? count : 0
  tabCounts.set(tabId, n)

  // 尚未确定激活标签页时(如 SW 冷启动的首条消息)先以该标签页为准
  if (activeTabId === null) activeTabId = tabId

  if (tabId === activeTabId) applyActiveBadge()
}

/**
 * 重新确认激活标签页后刷新徽标
 * (每次都用 tabs.query 取实际状态,避免冷启动时序竞争)
 */
function applyActiveBadge() {
  try {
    if (!chrome.action) return
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
      void chrome.runtime.lastError
      if (tabs && tabs[0] && typeof tabs[0].id !== 'undefined') {
        activeTabId = tabs[0].id
      }
      paintActiveBadge()
    })
  } catch (e) {
    paintActiveBadge()
  }
}

/**
 * 按激活标签页的检测结果设置徽标与提示文案(**不改动图标**)
 *  - 检测到:绿色徽标 + 组件数量
 *  - 未检测到:清空徽标
 */
function paintActiveBadge() {
  var n = (activeTabId !== null && tabCounts.get(activeTabId)) || 0
  try {
    if (!chrome.action) return

    if (n > 0) {
      chrome.action.setBadgeBackgroundColor({ color: BADGE_ON_COLOR })
      chrome.action.setBadgeText({ text: n > 999 ? '999+' : String(n) })
      chrome.action.setTitle({ title: 'Bindview DevTools · 检测到 ' + n + ' 个组件' })
    } else {
      chrome.action.setBadgeText({ text: '' })
      chrome.action.setTitle({ title: 'Bindview DevTools' })
    }
  } catch (e) {
    /* action 未声明时忽略 */
  }
}

/**
 * 兜底探测:直接用 scripting 读取 MAIN world 中 Hook 的实例数
 *
 * 不依赖页面后端是否支持 `bindview:status` 消息,因此即使页面侧代码是较旧版本
 * (或消息通道异常),也能得到正确的检测结果。
 * @param {Number} tabId
 */
function probeTab(tabId) {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) return
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function () {
        var hook = window.__BINDVIEW_DEVTOOLS_GLOBAL_HOOK__
        if (hook && hook.instances && typeof hook.instances.size === 'number') return hook.instances.size
        return 0
      }
    }).then(function (results) {
      var count = results && results[0] ? results[0].result : 0
      setDetectState(tabId, count)
    }).catch(function () {
      // 页面不可注入(chrome:// / edge:// 等):按未检测到处理
      setDetectState(tabId, 0)
    })
  } catch (e) {
    /* ignore */
  }
}

// 工具栏弹出面板(popup)通过 runtime 消息查询当前标签页的检测结果
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'popup:getState') return

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
    void chrome.runtime.lastError
    var tabId = tabs && tabs[0] && typeof tabs[0].id !== 'undefined' ? tabs[0].id : null

    // 顺带探测一次,保证弹出面板看到的是最新结果
    if (tabId !== null) probeTab(tabId)

    sendResponse({
      count: tabId !== null ? (tabCounts.get(tabId) || 0) : 0,
      version: chrome.runtime.getManifest().version
    })
  })

  return true // 异步响应
})

// 来自页面内容脚本的消息(sender.tab 标识来源标签页)
chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || !msg.type) return
  var tabId = sender && sender.tab && typeof sender.tab.id !== 'undefined' ? sender.tab.id : null

  // 内容脚本就绪:登记该标签页,并补齐面板握手(替代原 Port 连接事件)
  if (msg.type === 'content:connected') {
    if (tabId === null) return
    contentTabs.add(tabId)
    // 先置灰(未检测到),随后两条路并行探测:
    //  1) 请求页面后端主动上报(快)
    //  2) scripting 直接读取 Hook 实例数(兜底,不依赖页面侧版本)
    setDetectState(tabId, 0)
    toPanels(tabId, { type: 'content:connected', tabId: tabId })
    if (panelPorts.has(tabId)) {
      toContent(tabId, { type: 'panel:connected' })
      toContent(tabId, { type: 'panel:refresh' })
    }
    toContent(tabId, { type: 'bindview:status:request' })
    probeTab(tabId)
    return
  }

  // 页面检测结果 / 工具栏探测结果:决定徽标(不转发给面板)
  if (msg.type === 'bindview:status' || msg.type === 'action:probe:result') {
    if (tabId !== null) setDetectState(tabId, msg.data && msg.data.count)
    return
  }

  // 其余消息一律转发给面板
  if (tabId !== null) toPanels(tabId, msg)
})

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== PANEL_PORT) return

  var tabId = null

  port.onMessage.addListener(function (msg) {
    void chrome.runtime.lastError
    if (!msg || !msg.type) return

    // 面板初始化:登记 tabId,并尝试唤醒页面后端
    if (msg.type === 'panel:init') {
      tabId = typeof msg.tabId === 'number' ? msg.tabId : null
      if (tabId === null) return
      getPanelSet(tabId).add(port)
      var alive = contentTabs.has(tabId)
      try {
        port.postMessage({ type: 'panel:connected', tabId: tabId, contentAlive: alive })
        void chrome.runtime.lastError
      } catch (e) {
        void chrome.runtime.lastError
      }
      if (alive) {
        toContent(tabId, { type: 'panel:connected' })
        toContent(tabId, { type: 'panel:refresh' })
      }
      return
    }

    // 其余消息一律转发给页面内容脚本
    if (tabId !== null) toContent(tabId, msg)
  })

  port.onDisconnect.addListener(function () {
    void chrome.runtime.lastError
    if (tabId === null) return
    var set = panelPorts.get(tabId)
    if (!set) return
    set.delete(port)
    if (set.size === 0) panelPorts.delete(tabId)
  })
})

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener(function (tabId) {
  toPanels(tabId, { type: 'content:disconnected', tabId: tabId })
  panelPorts.delete(tabId)
  contentTabs.delete(tabId)
  tabCounts.delete(tabId)
})

// 切换标签页:先按缓存的检测结果立即切换图标,再请该页重新上报一次以校正
chrome.tabs.onActivated.addListener(function (activeInfo) {
  if (!activeInfo || typeof activeInfo.tabId === 'undefined') return
  activeTabId = activeInfo.tabId
  applyActiveBadge()
  toContent(activeTabId, { type: 'bindview:status:request' })
  probeTab(activeTabId)
})

// 页面加载完成后立即探测一次(内容脚本连接与 complete 之间的时序竞争兜底)
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status === 'complete') probeTab(tabId)
})

// SW 启动时初始化一次(确定激活标签页并请求其重报)
applyActiveBadge()
setTimeout(function () {
  if (activeTabId !== null) toContent(activeTabId, { type: 'bindview:status:request' })
}, 0)

// 说明:不再监听 chrome.tabs.onUpdated 的 loading。
// 该事件在 SPA 路由切换 / pushState 时也可能触发,会让面板误以为页面重载而清空组件树。
// 真正的页面加载由内容脚本上线的 `content:connected` 覆盖,标签页关闭由 tabs.onRemoved 覆盖。

// 点击工具栏图标:让页面重新探测一次,并据此刷新高亮徽标
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || typeof tab.id === 'undefined') return
  var tabId = tab.id
  toContent(tabId, { type: 'action:probe' })
  probeTab(tabId)
})

// 说明:图标改为「全局 + 跟随激活标签页」后,不再需要 onStartup / onInstalled 的重置逻辑;
// SW 冷启动时会通过上面的 tabs.query 初始化当前激活标签页对应的外观。
