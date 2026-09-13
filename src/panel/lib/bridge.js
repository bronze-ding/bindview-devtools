/**
 * 面板 ↔ 背景 Service Worker 的 Port 连接封装
 * 负责建立长连接、上报 tabId,并在断开时自动重连。
 */

const PANEL_PORT = 'bindview-devtools-panel'

export function createBridge(tabId) {
  const messageHandlers = new Set()
  const statusHandlers = new Set()

  let port = null
  let status = 'disconnected'
  let reconnectTimer = null

  function setStatus(next) {
    if (status === next) return
    status = next
    statusHandlers.forEach(function (fn) { fn(status) })
  }

  function emitMessage(message) {
    messageHandlers.forEach(function (fn) { fn(message) })
  }

  function connect() {
    if (port) return
    try {
      port = chrome.runtime.connect({ name: PANEL_PORT })
    } catch (e) {
      void chrome.runtime.lastError
      port = null
      setStatus('disconnected')
      scheduleReconnect()
      return
    }

    port.onMessage.addListener(emitMessage)
    port.onDisconnect.addListener(function () {
      // 必须读取 lastError,避免页面进入 bfcache / SW 休眠时出现
      // "Unchecked runtime.lastError"
      void chrome.runtime.lastError
      port = null
      setStatus('disconnected')
      scheduleReconnect()
    })

    setStatus('connected')
    post({ type: 'panel:init', tabId: tabId })
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      connect()
    }, 1000)
  }

  function post(message) {
    if (!port) return false
    try {
      port.postMessage(message)
      if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message)
      return true
    } catch (e) {
      void chrome.runtime.lastError
      port = null
      setStatus('disconnected')
      scheduleReconnect()
      return false
    }
  }

  connect()

  return {
    send: post,
    onMessage: function (fn) {
      messageHandlers.add(fn)
      return function () { messageHandlers.delete(fn) }
    },
    onStatus: function (fn) {
      statusHandlers.add(fn)
      fn(status)
      return function () { statusHandlers.delete(fn) }
    },
    getStatus: function () { return status },
    getTabId: function () { return tabId }
  }
}
