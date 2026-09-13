/**
 * Bindview DevTools · 页面侧全局 Hook
 * ------------------------------------------------------------------
 * 运行在 MAIN world(document_start),必须先于应用脚本执行。
 *
 * 设计参照 Vue DevTools 的 `__VUE_DEVTOOLS_GLOBAL_HOOK__`:
 *   1. 在 window 上暴露一个全局事件总线 `__BINDVIEW_DEVTOOLS_GLOBAL_HOOK__`;
 *   2. 框架侧(bindview)在关键生命周期调用 `hook.emit(event, payload)`
 *      即可把组件事件抛给调试器,未安装插件时框架自动短路,零侵入;
 *   3. Hook 在未 `enable()` 之前会把事件缓存到 buffer,后端就绪后一次性回放,
 *      解决「内容脚本注入时机晚于应用初始化」的问题;
 *   4. 提供 `__BINDVIEW_DEVTOOLS_HOOK_REPLAY__` 回放钩子,
 *      支持扩展晚于应用加载(如扩展重载后手动触发)时补发全量快照。
 */
(function () {
  'use strict'

  var win = typeof window !== 'undefined' ? window : null
  if (!win) return

  var HOOK_NAME = '__BINDVIEW_DEVTOOLS_GLOBAL_HOOK__'
  var REPLAY_NAME = '__BINDVIEW_DEVTOOLS_HOOK_REPLAY__'
  var INSTALL_EVENT = 'bindview-devtools-hook-installed'
  var HOOK_VERSION = '1.0.0'
  var MAX_BUFFER = 5000

  // 已注入则直接复用(扩展每次页面加载只会注入一次)
  if (win[HOOK_NAME]) return

  var listeners = Object.create(null) // event -> [fn]
  var buffer = []
  var emits = [] // 最近事件环形记录(便于排查)

  function record(event, args) {
    emits.push({ event: event, args: args, timestamp: Date.now() })
    if (emits.length > MAX_BUFFER) emits.shift()
  }

  function dispatch(event, args) {
    var fns = listeners[event]
    if (fns && fns.length) {
      // 复制一份,避免监听器内部增删导致跳过
      var snapshot = fns.slice()
      for (var i = 0; i < snapshot.length; i++) {
        try {
          snapshot[i].apply(null, args)
        } catch (e) {
          console.error('[Bindview DevTools] event listener error:', event, e)
        }
      }
    }
    var all = listeners['*']
    if (all && all.length) {
      var snapshotAll = all.slice()
      for (var j = 0; j < snapshotAll.length; j++) {
        try {
          snapshotAll[j](event, args)
        } catch (e) {
          console.error('[Bindview DevTools] wildcard listener error:', event, e)
        }
      }
    }
  }

  var hook = {
    // 标记,便于框架/后端识别
    __bindviewDevtoolsHook: true,
    version: HOOK_VERSION,
    // 是否已连接后端;为 false 时事件进入 buffer
    enabled: false,
    // uid -> 真实组件实例(仅在页面世界有效,不会跨进程传递)
    instances: new Map(),
    // 已识别的应用根记录
    apps: [],
    // 最近事件记录(调试用)
    emits: emits,

    /**
     * 订阅事件
     * @returns {Function} 取消订阅
     */
    on: function (event, fn) {
      if (typeof fn !== 'function') return function () { }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
      return function () {
        hook.off(event, fn)
      }
    },

    /**
     * 订阅一次
     */
    once: function (event, fn) {
      var off = hook.on(event, function () {
        off()
        fn.apply(null, arguments)
      })
      return off
    },

    off: function (event, fn) {
      var fns = listeners[event]
      if (!fns) return
      if (!fn) {
        delete listeners[event]
        return
      }
      var idx = fns.indexOf(fn)
      if (idx > -1) fns.splice(idx, 1)
    },

    /**
     * 派发事件(框架侧调用入口)
     * 后端未就绪时先入 buffer,`enable()` 后按顺序回放
     */
    emit: function (event) {
      var args = Array.prototype.slice.call(arguments, 1)
      record(event, args)
      if (!hook.enabled) {
        buffer.push({ event: event, args: args })
        if (buffer.length > MAX_BUFFER) buffer.shift()
        return
      }
      dispatch(event, args)
    },

    /**
     * 后端就绪,回放缓存事件
     */
    enable: function () {
      if (hook.enabled) return
      hook.enabled = true
      var pending = buffer
      buffer = []
      for (var i = 0; i < pending.length; i++) {
        dispatch(pending[i].event, pending[i].args)
      }
    },

    disable: function () {
      hook.enabled = false
    },

    // ---- 实例注册表(由后端维护) ----
    addInstance: function (uid, vm) {
      if (uid) hook.instances.set(uid, vm)
    },
    getInstance: function (uid) {
      return hook.instances.get(uid)
    },
    removeInstance: function (uid) {
      hook.instances.delete(uid)
    },
    clearInstances: function () {
      hook.instances.clear()
    }
  }

  try {
    Object.defineProperty(win, HOOK_NAME, {
      value: hook,
      writable: false,
      configurable: true,
      enumerable: false
    })
  } catch (e) {
    win[HOOK_NAME] = hook
  }

  // 通知可能已经就绪的后端
  try {
    win.dispatchEvent(new CustomEvent(INSTALL_EVENT, { detail: hook }))
  } catch (e) {
    /* CustomEvent 不可用时忽略 */
  }

  // 处理框架在 Hook 之前注册的回放回调(扩展晚于应用加载的场景)
  try {
    var replay = win[REPLAY_NAME]
    if (Array.isArray(replay)) {
      win[REPLAY_NAME] = null
      for (var k = 0; k < replay.length; k++) {
        try {
          replay[k](hook)
        } catch (e) {
          console.error('[Bindview DevTools] replay callback error:', e)
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
})()
