/**
 * 面板状态容器:极简发布订阅
 */

export function createStore(initialState) {
  const state = Object.assign({
    status: 'disconnected',
    contentAlive: false,
    /** 页面正在重新加载(保留上一份快照,避免闪成空白) */
    pageReloading: false,
    /** 组件树快照 { apps, count, timestamp } */
    snapshot: null,
    /** 当前选中组件 uid */
    selectedUid: null,
    /** 组件详情(由后端序列化) */
    inspection: null,
    inspectionLoading: false,
    /** 事件时间线 */
    timeline: [],
    /** 时间线是否暂停记录 */
    timelinePaused: false,
    /** 暂停期间缓存的事件(继续记录时并入时间线) */
    pausedBuffer: [],
    /** 时间线筛选关键字(按事件名 / 目标 / 组件名过滤) */
    timelineFilter: '',
    /** 高亮开关 */
    highlightEnabled: true,
    /** 当前面板页签: components | router | timeline | settings */
    activeTab: 'components',
    /** 主题: dark | light | auto(跟随系统) */
    theme: 'dark',
    /** 组件视图布局: horizontal(左右) | vertical(上下) */
    layout: 'horizontal',
    /** 组件搜索关键字 */
    search: '',
    /** 展开的节点 uid 集合 */
    expanded: new Set(),
    /** 自动展开(首次快照时全量展开) */
    autoExpanded: false,
    /** 最后一次错误提示 */
    error: null
  }, initialState || {})

  const listeners = new Set()

  function set(patch) {
    let changed = false
    for (const key in patch) {
      if (state[key] !== patch[key]) {
        state[key] = patch[key]
        changed = true
      }
    }
    if (changed) listeners.forEach(function (fn) { fn(state) })
  }

  function subscribe(fn) {
    listeners.add(fn)
    return function () { listeners.delete(fn) }
  }

  return { state: state, set: set, subscribe: subscribe }
}
