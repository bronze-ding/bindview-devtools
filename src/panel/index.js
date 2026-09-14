/**
 * Bindview DevTools · 面板入口
 * ------------------------------------------------------------------
 * 组装布局、连接背景 Service Worker、处理来自页面后端的事件与 RPC。
 */
import { el, debounce } from './lib/dom.js'
import { createBridge } from './lib/bridge.js'
import { createRpc } from './lib/rpc.js'
import { createStore } from './lib/store.js'
import { createHeader } from './views/Header.js'
import { createComponentTree } from './views/ComponentTree.js'
import { createInspector } from './views/Inspector.js'
import { createEventsView } from './views/Events.js'
import { createRouterView } from './views/Router.js'
import { createSettingsView } from './views/Settings.js'

const tabId = chrome.devtools.inspectedWindow.tabId
const bridge = createBridge(tabId)
const rpc = createRpc(bridge)
const store = createStore({ treeRevision: 0, inspectionRevision: 0, routerRevision: 0 })

let toastTimer = null

/* ------------------------ 主题 / 布局偏好 ------------------------ */

const PREFS_KEY = 'bindview-devtools:prefs'
let themeMediaQuery = null

/** 解析实际生效的主题(auto 时跟随系统) */
function resolveTheme(theme) {
  if (theme !== 'auto') return theme === 'light' ? 'light' : 'dark'
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch (e) {
    return 'dark'
  }
}

/** 把主题写到 <html data-theme>,由 CSS 变量切换明暗 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

function savePrefs() {
  try {
    const data = {}
    data[PREFS_KEY] = { theme: store.state.theme, layout: store.state.layout }
    chrome.storage.local.set(data)
  } catch (e) {
    /* storage 不可用时忽略 */
  }
}

function loadPrefs() {
  try {
    chrome.storage.local.get(PREFS_KEY, function (res) {
      const prefs = (res && res[PREFS_KEY]) || {}
      const patch = {}
      if (prefs.theme) patch.theme = prefs.theme
      if (prefs.layout) patch.layout = prefs.layout
      if (Object.keys(patch).length) store.set(patch)
      applyTheme(store.state.theme)
    })
  } catch (e) {
    applyTheme(store.state.theme)
  }
}

// 跟随系统时,系统主题变化需实时反映
try {
  themeMediaQuery = window.matchMedia('(prefers-color-scheme: light)')
  themeMediaQuery.addEventListener('change', function () {
    if (store.state.theme === 'auto') applyTheme('auto')
  })
} catch (e) {
  /* 不支持 matchMedia 时忽略 */
}

/* ---------------------------- 布局 ---------------------------- */

const root = document.getElementById('root')
const headerBox = el('div', { class: 'bv-header-slot' })
const componentsView = el('section', { class: 'bv-view bv-view--components' })
const routerView = el('section', { class: 'bv-view bv-view--router' })
const timelineView = el('section', { class: 'bv-view bv-view--timeline' })
const settingsView = el('section', { class: 'bv-view bv-view--settings' })
const toastEl = el('div', { class: 'bv-toast' })
const main = el('main', { class: 'bv-main' }, [componentsView, routerView, timelineView, settingsView])

root.appendChild(el('div', { class: 'bv-app' }, [headerBox, main, toastEl]))

/* ---------------------------- API ---------------------------- */

function findPath(node, uid, trail) {
  const nextTrail = trail.concat([node.uid])
  if (node.uid === uid) return nextTrail
  if (!node.children) return null
  for (let i = 0; i < node.children.length; i++) {
    const result = findPath(node.children[i], uid, nextTrail)
    if (result) return result
  }
  return null
}

function bumpTree() {
  store.set({ treeRevision: store.state.treeRevision + 1 })
}

function ensureExpanded(uid) {
  const snapshot = store.state.snapshot
  if (!snapshot) return
  let path = null
  for (let i = 0; i < snapshot.apps.length; i++) {
    path = findPath(snapshot.apps[i].root, uid, [])
    if (path) break
  }
  if (!path || path.length < 2) return
  const expanded = new Set(store.state.expanded)
  let changed = false
  for (let i = 0; i < path.length - 1; i++) {
    if (!expanded.has(path[i])) {
      expanded.add(path[i])
      changed = true
    }
  }
  if (changed) store.set({ expanded: expanded, treeRevision: store.state.treeRevision + 1 })
}

function collectUids(node, out) {
  out.push(node.uid)
  if (node.children) node.children.forEach(function (child) { collectUids(child, out) })
  return out
}

function autoExpand(snapshot) {
  if (store.state.autoExpanded || !snapshot) return
  const uids = []
  snapshot.apps.forEach(function (app) { collectUids(app.root, uids) })
  store.set({
    autoExpanded: true,
    expanded: new Set(uids),
    treeRevision: store.state.treeRevision + 1
  })
}

const refreshSelected = debounce(function () {
  if (store.state.selectedUid) api.refreshInspection()
}, 150)

function treeContains(snapshot, uid) {
  if (!snapshot || !uid) return false
  function walk(node) {
    if (!node) return false
    if (node.uid === uid) return true
    if (!node.children) return false
    for (let i = 0; i < node.children.length; i++) {
      if (walk(node.children[i])) return true
    }
    return false
  }
  for (let i = 0; i < snapshot.apps.length; i++) {
    if (walk(snapshot.apps[i].root)) return true
  }
  return false
}

function flashNode(uid) {
  const node = document.querySelector('.bv-node[data-uid="' + uid + '"]')
  if (!node) return
  node.classList.add('bv-node--flash')
  setTimeout(function () { node.classList.remove('bv-node--flash') }, 450)
}

/* ------------------ 组件更新统计增量同步 ------------------ */
// 组件「更新」时后端只推增量(component:updated),不会再重发全量快照;
// 若不同步,树上的徽标会停留在上次快照时的旧值,而检查器每次 inspect 都取最新值,
// 于是同一组件的两处统计出现漂移。这里把增量写回快照节点并就地刷新徽标,
// 并用短节流合并高频更新,避免频繁操作 DOM。

const pendingStats = new Map()
let statsTimer = null

/** 在组件树快照中定位 uid 对应的节点 */
function findTreeNode(node, uid) {
  if (!node) return null
  if (node.uid === uid) return node
  if (!node.children) return null
  for (let i = 0; i < node.children.length; i++) {
    const found = findTreeNode(node.children[i], uid)
    if (found) return found
  }
  return null
}

function applyNodeStats(data) {
  const snapshot = store.state.snapshot
  if (!snapshot || !snapshot.apps) return

  let target = null
  for (let i = 0; i < snapshot.apps.length; i++) {
    target = findTreeNode(snapshot.apps[i].root, data.uid)
    if (target) break
  }
  if (!target) return

  target.updateCount = data.updateCount || 0
  target.lastDuration = typeof data.lastDuration === 'number' ? data.lastDuration : 0
  if (typeof data.totalDuration === 'number') target.totalDuration = data.totalDuration

  tree.updateStats(target)
}

function scheduleNodeStats(data) {
  if (!data || !data.uid) return
  pendingStats.set(data.uid, data)
  if (statsTimer) return
  statsTimer = setTimeout(function () {
    statsTimer = null
    pendingStats.forEach(function (item) { applyNodeStats(item) })
    pendingStats.clear()
  }, 120)
}

const api = {
  setTab: function (tab) {
    store.set({ activeTab: tab })
    // 切到路由页时拉取一次最新路由信息
    if (tab === 'router') api.routerRefresh()
  },

  setTheme: function (theme) {
    store.set({ theme: theme })
    applyTheme(theme)
    savePrefs()
  },

  setLayout: function (layout) {
    store.set({ layout: layout === 'vertical' ? 'vertical' : 'horizontal' })
    savePrefs()
  },

  setSearch: function (value) {
    store.set({ search: value, treeRevision: store.state.treeRevision + 1 })
  },

  toggleExpand: function (uid) {
    const expanded = new Set(store.state.expanded)
    if (expanded.has(uid)) expanded.delete(uid)
    else expanded.add(uid)
    store.set({ expanded: expanded, treeRevision: store.state.treeRevision + 1 })
  },

  /** 展开全部节点(autoExpanded 置位,避免被首次快照的自动展开覆盖) */
  expandAll: function () {
    const snapshot = store.state.snapshot
    const uids = []
    if (snapshot && snapshot.apps) {
      snapshot.apps.forEach(function (app) { collectUids(app.root, uids) })
    }
    store.set({
      expanded: new Set(uids),
      autoExpanded: true,
      treeRevision: store.state.treeRevision + 1
    })
  },

  /** 折叠全部节点 */
  collapseAll: function () {
    store.set({
      expanded: new Set(),
      autoExpanded: true,
      treeRevision: store.state.treeRevision + 1
    })
  },

  select: function (uid) {
    // 从时间线 / 路由点击时切回「组件」页签,否则选中结果不可见。
    // 注意:选中不再触发页面高亮 —— 高亮统一由右上角「高亮」开关(鼠标悬停)控制
    store.set({
      selectedUid: uid,
      inspection: null,
      activeTab: 'components',
      treeRevision: store.state.treeRevision + 1
    })
    ensureExpanded(uid)
    api.refreshInspection()
  },

  hover: function (uid) {
    if (!store.state.highlightEnabled) return
    rpc.call('hover', { uid: uid }).catch(function () { /* ignore */ })
  },

  endHover: function () {
    // 指针离开节点即取消高亮(高亮只由开关 + 悬停驱动)
    rpc.call('unhighlight').catch(function () { /* ignore */ })
  },

  scrollTo: function (uid) {
    rpc.call('scrollTo', { uid: uid }).then(function (res) {
      if (!res || !res.ok) {
        api.toast((res && res.error) || '定位失败')
        return
      }
      // 页面不足一屏 / 元素已在视口内时不会有滚动位移,用提示说明原因(元素仍会闪烁)
      api.toast(res.msg || '已定位到该组件')
    }).catch(function () {
      api.toast('定位失败:未连接到页面')
    })
  },

  routerRefresh: function () {
    rpc.call('getRouterInfo').then(function (info) {
      if (!info) return
      store.set({
        routerInfo: info,
        routerRevision: store.state.routerRevision + 1
      })
    }).catch(function () { /* ignore */ })
  },

  routerNavigate: function (path, query) {
    rpc.call('routerNavigate', { path: path, query: query || {} }).then(function (res) {
      api.toast(res && res.ok ? '已跳转 ' + path : ((res && res.error) || '跳转失败'))
      api.routerRefresh()
    }).catch(function (e) {
      api.toast(e.message)
    })
  },

  routerAction: function (action, n) {
    rpc.call('routerAction', { action: action, n: n }).then(function (res) {
      if (!res || !res.ok) api.toast((res && res.error) || '操作失败')
      api.routerRefresh()
    }).catch(function (e) {
      api.toast(e.message)
    })
  },

  /** 会话历史相对跳转($go) */
  routerGo: function (n) {
    api.routerAction('go', n)
  },

  /** 清空导航历史(仅清理调试器记录,不影响浏览器会话历史) */
  routerClearHistory: function () {
    rpc.call('clearNavigation').then(function (res) {
      if (!res || !res.ok) {
        api.toast('清空失败')
        return
      }
      api.toast('已清空导航历史')
      api.routerRefresh()
    }).catch(function (e) {
      api.toast(e.message)
    })
  },

  invokeMethod: function (uid, name) {
    rpc.call('invokeMethod', { uid: uid, name: name, args: [] }).then(function (res) {
      if (!res || !res.ok) {
        api.toast(name + '() 调用失败:' + ((res && res.error) || ''))
        return
      }
      const preview = res.result ? res.result.preview : 'undefined'
      api.toast(name + '() → ' + preview + ' · ' + Math.round(res.duration) + ' ms')
      api.refreshInspection()
    }).catch(function (e) {
      api.toast(e.message)
    })
  },

  /** 时间线筛选关键字 */
  setTimelineFilter: function (value) {
    store.set({ timelineFilter: value })
  },

  /**
   * 暂停 / 继续记录时间线
   * 暂停期间事件进入 pausedBuffer,继续时一次性并入(不丢事件)
   */
  toggleTimelinePause: function () {
    const paused = !store.state.timelinePaused
    if (!paused) {
      const buffer = store.state.pausedBuffer || []
      if (buffer.length) {
        const timeline = store.state.timeline.concat(buffer)
        if (timeline.length > 500) timeline.splice(0, timeline.length - 500)
        store.set({ timeline: timeline, pausedBuffer: [], timelinePaused: false })
        return
      }
    }
    store.set({ timelinePaused: paused })
  },

  refresh: function () {
    bridge.send({ type: 'panel:refresh' })
    api.fetchTree(0)
  },

  /**
   * 拉取组件树;若页面正在重新加载导致拿不到数据,自动重试
   * @param {Number} attempt 已重试次数
   */
  fetchTree: function (attempt) {
    rpc.call('rescan').then(function (result) {
      // 全量扫描后,选中组件可能已不存在
      const selected = store.state.selectedUid
      if (selected && !treeContains(store.state.snapshot, selected)) {
        store.set({ selectedUid: null, inspection: null })
      }
      if (attempt === 0) {
        api.toast('已重新扫描 ' + ((result && result.count) || 0) + ' 个组件')
      }
      api.routerRefresh()

      // 页面可能刚重载、应用尚未初始化,稍后重试
      const snapshot = store.state.snapshot
      const empty = !snapshot || !snapshot.apps || !snapshot.apps.length
      if (empty && attempt < 3) {
        setTimeout(function () { api.fetchTree(attempt + 1) }, 500)
      }
    }).catch(function () {
      if (attempt < 3) {
        setTimeout(function () { api.fetchTree(attempt + 1) }, 500)
      } else {
        api.toast('刷新失败:未连接到页面')
      }
    })
  },

  toast: function (message) {
    if (!toastEl) return
    toastEl.textContent = message
    toastEl.classList.add('bv-toast--show')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('bv-toast--show')
    }, 1600)
  },

  rerender: function () {
    render()
  },

  toggleHighlight: function () {
    const next = !store.state.highlightEnabled
    store.set({ highlightEnabled: next })
    rpc.call('setHighlightEnabled', { enabled: next }).catch(function () { /* ignore */ })
  },

  clearTimeline: function () {
    rpc.call('clearTimeline').catch(function () { /* ignore */ })
    store.set({ timeline: [], pausedBuffer: [] })
  },

  refreshInspection: function () {
    const uid = store.state.selectedUid
    if (!uid) {
      store.set({ inspection: null, inspectionLoading: false })
      return
    }
    store.set({ inspectionLoading: true, error: null })
    rpc.call('inspect', { uid: uid }).then(function (result) {
      if (store.state.selectedUid !== uid) return
      store.set({
        inspection: result,
        inspectionLoading: false,
        inspectionRevision: (store.state.inspectionRevision || 0) + 1
      })
      ensureExpanded(uid)
    }).catch(function (e) {
      store.set({ inspectionLoading: false, error: e.message })
    })
  },

  /**
   * 写入 data
   * @returns {Promise<{ok:Boolean, error:String}>} 调用方可据此做行内反馈
   */
  setState: function (uid, source, path, descriptor) {
    return rpc.call('setState', { uid: uid, source: source, path: path, value: descriptor })
      .then(function (result) {
        if (!result || !result.ok) {
          store.set({ error: (result && result.error) || '写入失败' })
        } else if (result.unchanged) {
          // 值未变化:框架不会触发更新,这里同步给出提示,避免误以为写入失败
          store.set({ error: null })
          api.toast('值未变化,未写入')
        } else {
          store.set({ error: null })
        }
        api.refreshInspection()
        return result || { ok: false, error: '写入失败' }
      })
      .catch(function (e) {
        store.set({ error: e.message })
        api.refreshInspection()
        return { ok: false, error: e.message }
      })
  },

  /** 删除 data 上的属性 / 数组元素 */
  deleteState: function (uid, source, path) {
    rpc.call('deleteState', { uid: uid, source: source, path: path })
      .then(function (result) {
        if (!result || !result.ok) {
          store.set({ error: (result && result.error) || '删除失败' })
        } else {
          store.set({ error: null })
          api.toast('已删除 ' + source + '.' + path.join('.'))
        }
        api.refreshInspection()
      })
      .catch(function (e) {
        store.set({ error: e.message })
        api.refreshInspection()
      })
  },

  /** 读取 data 目标值的 JSON 文本(供「以 JSON 编辑」) */
  getRawJson: function (uid, source, path) {
    return rpc.call('getRawJson', { uid: uid, source: source, path: path })
  },

  /**
   * 为「未定义 data」的组件初始化一个空的响应式 data
   * @returns {Promise<{ok:Boolean, existed:Boolean, error:String}>}
   */
  initData: function (uid) {
    return rpc.call('initData', { uid: uid }).then(function (res) {
      if (res && res.ok) {
        api.toast(res.existed ? 'data 已存在' : '已初始化 data,可新增属性')
        api.refreshInspection()
      }
      return res || { ok: false, error: '初始化失败' }
    }).catch(function (e) {
      return { ok: false, error: e.message }
    })
  },

  /** 把选中组件暴露到页面控制台(window.$vm),并尝试在控制台中显示 */
  exposeInConsole: function () {
    const uid = store.state.selectedUid
    if (!uid) return
    rpc.call('exposeInstance', { uid: uid }).then(function (res) {
      if (!res || !res.ok) {
        api.toast((res && res.error) || '无法暴露实例')
        return
      }
      api.toast('已在控制台暴露 $vm' + (res.name ? '(<' + res.name + '>)' : ''))
      try {
        // 命令式 API 可能不可用,失败时忽略(用户仍可手动输入 $vm)
        chrome.devtools.inspectedWindow.eval('inspect(window.$vm)')
      } catch (e) { /* ignore */ }
    }).catch(function (e) {
      api.toast(e.message)
    })
  }
}

/* ---------------------------- 视图 ---------------------------- */

const updateHeader = createHeader(headerBox, api)
const tree = createComponentTree(componentsView, api)
const inspector = createInspector(componentsView, api)
const routerInfoView = createRouterView(routerView, api)
const events = createEventsView(timelineView, api)
const settings = createSettingsView(settingsView, api)

function render() {
  const state = store.state
  updateHeader(state)

  componentsView.classList.toggle('bv-view--hidden', state.activeTab !== 'components')
  componentsView.classList.toggle('bv-layout--vertical', state.layout === 'vertical')
  routerView.classList.toggle('bv-view--hidden', state.activeTab !== 'router')
  timelineView.classList.toggle('bv-view--hidden', state.activeTab !== 'timeline')
  settingsView.classList.toggle('bv-view--hidden', state.activeTab !== 'settings')

  tree.render(state)
  inspector.render(state)
  routerInfoView.render(state)
  events.render(state)
  settings.render(state)
}

store.subscribe(render)

/* ------------------------- 事件处理 ------------------------- */

function pushTimelineEvent(entry) {
  // 暂停记录:先进入缓冲区,继续时再并入(不丢事件)
  if (store.state.timelinePaused) {
    const buffer = (store.state.pausedBuffer || []).concat([entry])
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
    store.set({ pausedBuffer: buffer })
    return
  }
  const timeline = store.state.timeline.concat([entry])
  if (timeline.length > 500) timeline.splice(0, timeline.length - 500)
  store.set({ timeline: timeline })
}

bridge.onStatus(function (status) {
  store.set({ status: status })
})

bridge.onMessage(function (message) {
  if (!message || !message.type) return

  switch (message.type) {
    case 'panel:connected':
      store.set({ status: 'connected', contentAlive: !!message.contentAlive })
      if (message.contentAlive) api.refresh()
      break

    case 'content:connected':
      store.set({ contentAlive: true, pageReloading: false })
      // 页面刷新 / 导航后重新握手:让新页面的后端确认面板在线,
      // 后台会回推 panel:connected(携带 contentAlive),再由其触发刷新
      bridge.send({ type: 'panel:init', tabId: tabId })
      api.refresh()
      break

    case 'content:disconnected':
      // 页面正在重新加载:保留上一份组件树(避免闪成空白「未检测到应用」),
      // 仅清除与旧实例绑定的选中态;新内容脚本上线后会通过 content:connected 触发刷新
      store.set({
        contentAlive: false,
        pageReloading: true,
        inspection: null,
        selectedUid: null
      })
      break

    case 'backend:ready':
      api.refresh()
      break

    case 'snapshot':
      store.set({
        snapshot: message.data,
        pageReloading: false,
        treeRevision: store.state.treeRevision + 1
      })
      autoExpand(message.data)
      break

    case 'component:updated':
      if (message.data && message.data.uid) {
        // 同步树徽标统计(与检查器共用同一份后端 meta)
        scheduleNodeStats(message.data)
        flashNode(message.data.uid)
        if (store.state.selectedUid === message.data.uid) refreshSelected()
      }
      break

    case 'state:invalid':
      if (message.data && store.state.selectedUid === message.data.uid) {
        store.set({ inspection: null, selectedUid: null })
      }
      break

    case 'timeline:list':
      store.set({
        timeline: Array.isArray(message.data) ? message.data : [],
        pausedBuffer: []
      })
      break

    case 'timeline:event':
      if (message.data) pushTimelineEvent(message.data)
      break

    case 'highlight:changed':
      if (message.data) store.set({ highlightEnabled: !!message.data.enabled })
      break

    case 'router:info':
      store.set({
        routerInfo: message.data,
        routerRevision: store.state.routerRevision + 1
      })
      break

    default:
      break
  }
})

// 先按偏好应用主题,再渲染;随后异步读取已保存的偏好
applyTheme(store.state.theme)
loadPrefs()

render()
