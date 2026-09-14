/**
 * Bindview DevTools · 页面后端(MAIN world)
 * ------------------------------------------------------------------
 * 连接全局 Hook 与扩展面板,是调试能力的核心:
 *
 *   1. 订阅框架抛出的 `component:added / updated / removed / app:rescan` 事件,
 *      维护「应用 → 组件树」的元信息;
 *   2. 按需序列化组件状态(响应式 data / props / refs / methods),
 *      转换为可跨进程传递的纯数据结构;
 *   3. 支持就地编辑状态 —— 直接写回 bindview 的 Proxy,触发响应式更新;
 *   4. 提供组件高亮遮罩与滚动定位;
 *   5. 维护事件时间线并推送给面板。
 */
(function () {
  'use strict'

  var SOURCE = 'bindview-devtools'
  var HOOK_NAME = '__BINDVIEW_DEVTOOLS_GLOBAL_HOOK__'
  var INSTALL_EVENT = 'bindview-devtools-hook-installed'

  var MAX_TIMELINE = 500
  var MAX_DEPTH = 6
  var MAX_ENTRIES = 100
  var MAX_STRING = 200

  if (window.__BINDVIEW_DEVTOOLS_BACKEND_LOADED__) return
  window.__BINDVIEW_DEVTOOLS_BACKEND_LOADED__ = true

  var hook = null
  var unsubscribers = []
  var treeTimer = null
  var overlay = null
  var overlayLabel = null
  var overlayTarget = null
  var timelineSeq = 0

  var state = {
    /** uid -> meta */
    meta: new Map(),
    /** uid 创建顺序 */
    order: [],
    /** 事件时间线 */
    timeline: [],
    // 高亮开关默认开启(悬停高亮)
    highlightEnabled: true,
    highlightedUid: null,
    panelConnected: false
  }

  /** bindview-router 相关信息(由路由插件侧上报) */
  var routerState = {
    installed: false,
    mode: null,
    version: null,
    current: { oldURL: '', newURL: '', query: null },
    tables: [],
    navigation: [],
    // 当前所处导航历史下标(-1 表示尚无记录)
    pointer: -1
  }
  var routerTimer = null

  /* ------------------------------------------------------------------ */
  /* 通用工具                                                            */
  /* ------------------------------------------------------------------ */

  function now() { return Date.now() }

  function truncate(str, len) {
    str = String(str)
    var limit = len || MAX_STRING
    return str.length > limit ? str.slice(0, limit) + '…' : str
  }

  function quote(str) {
    return '"' + truncate(str, 60) + '"'
  }

  function safeGet(obj, key) {
    try {
      return obj[key]
    } catch (e) {
      return undefined
    }
  }

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]'
  }

  /* ------------------------------------------------------------------ */
  /* 与扩展面板通信                                                       */
  /* ------------------------------------------------------------------ */

  function post(type, data) {
    try {
      window.postMessage({
        source: SOURCE,
        direction: 'to-extension',
        payload: { type: type, data: data }
      }, '*')
    } catch (e) {
      /* 忽略 */
    }
  }

  function pushTimeline(entry) {
    entry.id = ++timelineSeq
    state.timeline.push(entry)
    if (state.timeline.length > MAX_TIMELINE) state.timeline.shift()
    // 不做面板在线判断:未连接时由内容脚本/后台自然丢弃,避免因握手丢失而漏推
    post('timeline:event', entry)
  }

  function scheduleTree() {
    if (treeTimer) return
    treeTimer = setTimeout(function () {
      treeTimer = null
      sendTree()
    }, 16)
  }

  function sendTree() {
    var tree = buildTree()
    post('snapshot', tree)
    // 告知后台本页是否检测到 bindview 应用(用于工具栏图标高亮)
    // 该消息由内容脚本转发给后台,但不会转发给面板
    post('bindview:status', { count: tree.count, apps: tree.apps.length })
  }

  /* ------------------------------------------------------------------ */
  /* 组件元信息与组件树                                                   */
  /* ------------------------------------------------------------------ */

  function describeVm(vm) {
    var parent = safeGet(vm, '_parent')
    return {
      uid: safeGet(vm, '_key'),
      name: safeGet(vm, 'name') || 'AnonymousComponent',
      parentUid: parent && parent._key ? parent._key : null,
      isComponent: !!safeGet(vm, '_isComponent'),
      version: (vm.constructor && vm.constructor.version) || null,
      instance: vm
    }
  }

  function onComponentAdded(payload, silent) {
    if (!payload || !payload.uid) return
    var uid = payload.uid
    var prev = state.meta.get(uid)

    var meta = {
      uid: uid,
      name: payload.name || 'AnonymousComponent',
      parentUid: payload.parentUid || null,
      isComponent: !!payload.isComponent,
      version: payload.version || null,
      updateCount: prev ? prev.updateCount : 0,
      lastDuration: prev ? prev.lastDuration : 0,
      // 累计渲染耗时(用于面板展示平均耗时 / 找出高频慢组件)
      totalDuration: prev && prev.totalDuration ? prev.totalDuration : 0,
      lastUpdate: now(),
      isRoot: !payload.parentUid
    }
    state.meta.set(uid, meta)
    if (state.order.indexOf(uid) === -1) state.order.push(uid)
    if (payload.instance && hook) hook.addInstance(uid, payload.instance)

    if (!silent) {
      pushTimeline({
        event: meta.isRoot ? 'app:init' : 'component:added',
        uid: uid,
        name: meta.name,
        timestamp: payload.timestamp || now()
      })
    }
    scheduleTree()
    scheduleRouterInfo()
  }

  function onComponentUpdated(payload) {
    if (!payload || !payload.uid) return
    var meta = state.meta.get(payload.uid)
    if (!meta) return
    meta.updateCount++
    meta.lastDuration = payload.duration || 0
    meta.totalDuration = (meta.totalDuration || 0) + meta.lastDuration
    meta.lastUpdate = now()
    pushTimeline({
      event: 'component:updated',
      uid: payload.uid,
      name: meta.name,
      duration: meta.lastDuration,
      timestamp: payload.timestamp || now()
    })
    // 不做面板在线判断(原因同上),保证面板重新握手后能持续收到增量更新
    post('component:updated', {
      uid: payload.uid,
      updateCount: meta.updateCount,
      lastDuration: meta.lastDuration
    })
  }

  function onComponentRemoved(payload) {
    if (!payload || !payload.uid) return
    var uid = payload.uid
    var meta = state.meta.get(uid)
    state.meta.delete(uid)
    var index = state.order.indexOf(uid)
    if (index > -1) state.order.splice(index, 1)
    if (hook) hook.removeInstance(uid)
    if (overlayTarget === uid) clearHighlight()
    pushTimeline({
      event: 'component:removed',
      uid: uid,
      name: (meta && meta.name) || payload.name || 'AnonymousComponent',
      timestamp: payload.timestamp || now()
    })
    post('state:invalid', { uid: uid })
    scheduleTree()
    scheduleRouterInfo()
  }

  /**
   * 回放/补发:扩展晚于应用加载时重建完整状态
   */
  function onRescan(payload) {
    var list = (payload && payload.components) || []
    for (var i = 0; i < list.length; i++) {
      onComponentAdded(list[i], true)
    }
    // 以实例表兜底同步一次(覆盖 Hook 缓存未触达的组件)
    if (hook && hook.instances) {
      hook.instances.forEach(function (vm, uid) {
        if (!state.meta.has(uid)) onComponentAdded(describeVm(vm), true)
      })
    }
    sendTree()
  }

  /**
   * 全量重新扫描:以框架提供的「存活实例快照」为准,清空后重建组件元信息。
   *
   * 与增量同步不同,这里会移除已销毁 / 已下线的组件,并覆盖扩展注入之前
   * 就已存在的组件,因此点击「刷新」能真实反映页面当前状态。
   *
   * @returns {Number} 重建后的组件数量
   */
  function fullRescan() {
    var list = []

    if (hook) {
      // 优先使用框架挂载的快照提供器(包含扩展注入前就已存在的组件)
      if (typeof hook.getSnapshot === 'function') {
        try {
          list = hook.getSnapshot() || []
        } catch (e) {
          list = []
        }
      }
      // 兜底:使用 Hook 自身的实例注册表
      if (!list.length && hook.instances && hook.instances.size) {
        list = []
        hook.instances.forEach(function (vm, uid) {
          if (vm) list.push(Object.assign(describeVm(vm), { instance: vm }))
        })
      }
    }

    // 先清空再重建,保证已销毁组件被移除
    state.meta.clear()
    state.order = []
    if (hook && typeof hook.clearInstances === 'function') hook.clearInstances()

    for (var i = 0; i < list.length; i++) {
      onComponentAdded(list[i], true)
    }

    sendTree()
    return state.order.length
  }

  /**
   * 构建可序列化的组件树快照
   */
  function buildTree() {
    var childrenOf = new Map()
    var roots = []

    state.order.forEach(function (uid) {
      var meta = state.meta.get(uid)
      if (!meta) return
      var parentUid = meta.parentUid
      if (parentUid && state.meta.has(parentUid)) {
        var bucket = childrenOf.get(parentUid)
        if (!bucket) {
          bucket = []
          childrenOf.set(parentUid, bucket)
        }
        bucket.push(uid)
      } else {
        roots.push(uid)
      }
    })

    function build(uid) {
      var meta = state.meta.get(uid)
      var node = {
        uid: uid,
        name: meta.name,
        isComponent: meta.isComponent,
        updateCount: meta.updateCount,
        lastDuration: meta.lastDuration,
        totalDuration: meta.totalDuration || 0,
        // 路由相关组件(Switch / Link)在树上标注其路由信息
        route: routeBadgeFor(hook && hook.getInstance(uid), meta),
        children: []
      }
      var kids = childrenOf.get(uid)
      if (kids) {
        for (var i = 0; i < kids.length; i++) node.children.push(build(kids[i]))
      }
      return node
    }

    var apps = []
    for (var r = 0; r < roots.length; r++) {
      var rootMeta = state.meta.get(roots[r])
      apps.push({
        id: roots[r],
        name: (rootMeta && rootMeta.name) || 'Bindview App',
        version: (rootMeta && rootMeta.version) || null,
        updateCount: (rootMeta && rootMeta.updateCount) || 0,
        root: build(roots[r])
      })
    }

    return {
      apps: apps,
      count: state.order.length,
      timestamp: now()
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态序列化                                                          */
  /* ------------------------------------------------------------------ */

  function serializeDom(node) {
    if (!node) return { type: 'null', preview: 'null' }
    if (typeof Node !== 'undefined' && node instanceof Node) {
      if (node.nodeType === 3) {
        return { type: 'dom', domType: 'text', preview: '#text ' + quote(node.nodeValue || '') }
      }
      if (node.nodeType === 8) {
        return { type: 'dom', domType: 'comment', preview: '<!--…-->' }
      }
      var tag = node.tagName ? node.tagName.toLowerCase() : 'node'
      var id = node.id ? '#' + node.id : ''
      var cls = ''
      try {
        if (node.classList && node.classList.length) {
          cls = '.' + Array.prototype.slice.call(node.classList).join('.')
        }
      } catch (e) { /* ignore */ }
      return { type: 'dom', domType: 'element', tag: tag, preview: '<' + tag + id + cls + '>' }
    }
    return { type: 'dom', domType: 'unknown', preview: String(node) }
  }

  function serializeValue(value, depth, seen) {
    depth = depth || 0
    seen = seen || []
    var type = typeof value

    // null / undefined 同样标记为可编辑:面板据此提供「写入新值」的入口
    if (value === null) return { type: 'null', preview: 'null', editable: true }
    if (type === 'undefined') return { type: 'undefined', preview: 'undefined', editable: true }

    if (type === 'string') return { type: 'string', value: value, preview: quote(value), editable: true }
    if (type === 'number') return { type: 'number', value: value, preview: String(value), editable: true }
    if (type === 'boolean') return { type: 'boolean', value: value, preview: String(value), editable: true }
    if (type === 'bigint') return { type: 'bigint', value: String(value), preview: String(value) + 'n', editable: true }
    if (type === 'symbol') return { type: 'symbol', value: String(value), preview: String(value), editable: false }
    if (type === 'function') {
      return {
        type: 'function',
        name: value.name || 'anonymous',
        preview: 'ƒ ' + (value.name || 'anonymous') + '()',
        editable: false
      }
    }

    if (typeof Node !== 'undefined' && value instanceof Node) return serializeDom(value)
    if (value instanceof Date) return { type: 'date', value: value.toISOString(), preview: 'Date ' + value.toISOString(), editable: false }
    if (value instanceof RegExp) return { type: 'regexp', value: String(value), preview: String(value), editable: false }
    if (value instanceof Error) return { type: 'error', preview: (value.name || 'Error') + ': ' + value.message, editable: false }

    var isArray = Array.isArray(value)
    var isMap = Object.prototype.toString.call(value) === '[object Map]'
    var isSet = Object.prototype.toString.call(value) === '[object Set]'

    if (!isArray && !isPlainObject(value) && !isMap && !isSet) {
      return { type: 'object', preview: Object.prototype.toString.call(value), editable: false }
    }

    if (seen.indexOf(value) > -1) {
      return { type: 'circular', preview: '[Circular]', editable: false }
    }
    var nextSeen = seen.concat([value])

    if (depth >= MAX_DEPTH) {
      return {
        type: isArray ? 'array' : 'object',
        preview: isArray ? 'Array(' + value.length + ') {…}' : '{…}',
        truncated: true,
        editable: false
      }
    }

    var entries = []
    var lengthInfo = null

    if (isArray) {
      lengthInfo = value.length
      var arrayLimit = Math.min(value.length, MAX_ENTRIES)
      for (var i = 0; i < arrayLimit; i++) {
        entries.push({ key: String(i), kind: 'index', value: serializeValue(safeGet(value, i), depth + 1, nextSeen) })
      }
      return {
        type: 'array',
        length: value.length,
        preview: 'Array(' + value.length + ')',
        entries: entries,
        truncated: value.length > MAX_ENTRIES,
        editable: false
      }
    }

    if (isMap) {
      var mapCount = 0
      value.forEach(function (v, k) {
        if (mapCount >= MAX_ENTRIES) return
        mapCount++
        entries.push({
          key: typeof k === 'string' ? k : truncate(String(k), 40),
          kind: 'map-value',
          value: serializeValue(v, depth + 1, nextSeen)
        })
      })
      return { type: 'map', size: value.size, preview: 'Map(' + value.size + ')', entries: entries, editable: false }
    }

    if (isSet) {
      var setCount = 0
      value.forEach(function (v) {
        if (setCount >= MAX_ENTRIES) return
        entries.push({ key: String(setCount++), kind: 'set-value', value: serializeValue(v, depth + 1, nextSeen) })
      })
      return { type: 'set', size: value.size, preview: 'Set(' + value.size + ')', entries: entries, editable: false }
    }

    var keys = Object.keys(value)
    var limit = Math.min(keys.length, MAX_ENTRIES)
    for (var j = 0; j < limit; j++) {
      var key = keys[j]
      entries.push({
        key: key,
        kind: 'prop',
        value: serializeValue(safeGet(value, key), depth + 1, nextSeen)
      })
    }

    return {
      type: 'object',
      preview: '{' + truncate(keys.join(', '), 40) + '}',
      entries: entries,
      keys: keys,
      truncated: keys.length > MAX_ENTRIES,
      lengthInfo: lengthInfo,
      editable: false
    }
  }

  /**
   * 把任意值转换为 JSON 安全的纯数据(供面板「以 JSON 编辑」)
   * DOM / 函数 / 循环引用等不可序列化内容会转为可读字符串,避免抛错
   */
  function toJsonSafe(value, seen, depth) {
    seen = seen || []
    depth = depth || 0
    var type = typeof value

    if (value === null) return null
    if (type === 'undefined') return undefined
    if (type === 'string') return truncate(value, 2000)
    if (type === 'number' || type === 'boolean') return value
    if (type === 'bigint') return String(value)
    if (type === 'symbol') return String(value)
    if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']'

    if (typeof Node !== 'undefined' && value instanceof Node) return serializeDom(value).preview
    if (value instanceof Date) return value.toISOString()
    if (value instanceof RegExp) return String(value)

    if (seen.indexOf(value) > -1) return '[Circular]'
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]'

    var nextSeen = seen.concat([value])

    if (Array.isArray(value)) {
      var arr = []
      var arrayLimit = Math.min(value.length, MAX_ENTRIES)
      for (var i = 0; i < arrayLimit; i++) {
        arr.push(toJsonSafe(safeGet(value, i), nextSeen, depth + 1))
      }
      return arr
    }

    if (Object.prototype.toString.call(value) === '[object Map]') {
      var mapObj = {}
      var mapCount = 0
      value.forEach(function (v, k) {
        if (mapCount >= MAX_ENTRIES) return
        mapCount++
        mapObj[String(k)] = toJsonSafe(v, nextSeen, depth + 1)
      })
      return mapObj
    }

    if (Object.prototype.toString.call(value) === '[object Set]') {
      var setArr = []
      var setCount = 0
      value.forEach(function (v) {
        if (setCount >= MAX_ENTRIES) return
        setCount++
        setArr.push(toJsonSafe(v, nextSeen, depth + 1))
      })
      return setArr
    }

    if (!isPlainObject(value)) return Object.prototype.toString.call(value)

    var out = {}
    var keys = Object.keys(value)
    var limit = Math.min(keys.length, MAX_ENTRIES)
    for (var j = 0; j < limit; j++) {
      out[keys[j]] = toJsonSafe(safeGet(value, keys[j]), nextSeen, depth + 1)
    }
    return out
  }

  /** 解析 data 上的目标值(仅 data 可编辑,其余分区只读) */
  function resolveDataTarget(vm, source, path) {
    if (source !== 'data') return { ok: false, error: '仅 data 支持编辑(其他分区为只读)' }
    var root = vm.data
    if (!root || typeof root !== 'object') return { ok: false, error: 'data 不是可编辑对象' }
    var trail = Array.isArray(path) ? path : []
    var target = root
    for (var i = 0; i < trail.length; i++) {
      target = target === null || target === undefined ? undefined : safeGet(target, trail[i])
      if (target === null || target === undefined) {
        return { ok: false, error: '路径不存在: data.' + trail.slice(0, i + 1).join('.') }
      }
    }
    return { ok: true, value: target }
  }

  /**
   * 读取 data 上的目标值并转为 JSON 文本(供面板「以 JSON 编辑」)
   * 超过深度 / 条目上限的内容会被截断,DOM、函数、循环引用转为可读字符串
   */
  function getRawJson(uid, source, path) {
    var vm = hook && hook.getInstance(uid)
    if (!vm) return { ok: false, error: '组件实例已销毁' }

    var resolved = resolveDataTarget(vm, source, path)
    if (!resolved.ok) return resolved

    var value = resolved.value
    var valueType = Array.isArray(value)
      ? 'array'
      : (value && typeof value === 'object' ? 'object' : typeof value)

    var json
    try {
      json = JSON.stringify(toJsonSafe(value, [], 0), null, 2)
    } catch (e) {
      return { ok: false, error: '序列化失败: ' + ((e && e.message) || String(e)) }
    }
    if (json === undefined) json = 'null'

    return { ok: true, json: json, valueType: valueType, huge: json.length > 200000 }
  }

  /* ------------------------------------------------------------------ */
  /* 组件检查                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 描述组件方法:形参个数 / 是否 async / 源码
   * vm.methods[name] 是 bind(vm) 后的绑定函数,源码需通过 __bvRaw__ 取原始函数
   */
  function describeMethods(vm) {
    var methods = vm ? safeGet(vm, 'methods') : null
    if (!methods) return []

    var names = []
    try {
      names = Object.keys(methods)
    } catch (e) {
      return []
    }

    var out = []
    for (var i = 0; i < names.length; i++) {
      var name = names[i]
      var fn = safeGet(methods, name)

      if (typeof fn !== 'function') {
        out.push({ name: name, arity: 0, async: false, source: '' })
        continue
      }

      var raw = safeGet(fn, '__bvRaw__') || fn
      var source = ''
      var asyncFlag = false

      try {
        source = truncate(Function.prototype.toString.call(raw), 4000)
      } catch (e) {
        source = ''
      }
      try {
        asyncFlag = !!(raw.constructor && raw.constructor.name === 'AsyncFunction')
      } catch (e) {
        asyncFlag = false
      }

      out.push({
        name: name,
        arity: typeof raw.length === 'number' ? raw.length : 0,
        async: asyncFlag,
        source: source
      })
    }
    return out
  }

  /**
   * 组装检查器分区:仅路由组件(Switch / Link)额外带一个只读「路由」分区
   */
  function buildSections(vm, propsNode, dataNode, refsNode) {
    var sections = []
    var routeSection = buildRouteSection(vm)
    if (routeSection) sections.push(routeSection)

    sections.push(
      // props 由父组件传入,只读;仅 data 可编辑
      { id: 'props', label: 'props', node: propsNode, source: null, editable: false },
      { id: 'data', label: 'data', node: dataNode, source: 'data', editable: true },
      { id: 'refs', label: 'refs', node: refsNode, source: null, editable: false }
    )
    return sections
  }

  function inspectComponent(uid) {
    var meta = state.meta.get(uid) || null
    var vm = hook && hook.getInstance(uid)

    if (!vm) {
      return {
        uid: uid,
        missing: true,
        meta: meta,
        name: (meta && meta.name) || 'Unknown Component',
        sections: []
      }
    }

    var dataNode = vm.data === void 0 || vm.data === null
      ? { type: 'null', preview: 'null', editable: false }
      : serializeValue(vm.data, 0, [])

    var propsNode = vm._props === void 0 || vm._props === null
      ? { type: 'null', preview: 'null', editable: false }
      : serializeValue(vm._props, 0, [])

    var refsNode = serializeValue(vm.refs || {}, 0, [])

    var lifeNames = []
    if (vm.life && isPlainObject(vm.life)) {
      lifeNames = Object.keys(vm.life)
    }

    return {
      uid: uid,
      name: vm.name || (meta && meta.name) || 'AnonymousComponent',
      missing: false,
      meta: meta,
      isComponent: !!vm._isComponent,
      version: (vm.constructor && vm.constructor.version) || (meta && meta.version) || null,
      sections: buildSections(vm, propsNode, dataNode, refsNode),
      methods: describeMethods(vm),
      life: lifeNames,
      childrenCount: vm._KeyMapComponent ? vm._KeyMapComponent.size : 0,
      el: serializeDom(vm.el),
      updateCount: meta ? meta.updateCount : 0,
      lastDuration: meta ? meta.lastDuration : 0,
      totalDuration: meta ? meta.totalDuration || 0 : 0
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态编辑                                                            */
  /* ------------------------------------------------------------------ */

  function parseDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') return undefined
    switch (descriptor.kind) {
      case 'string': return String(descriptor.value)
      case 'number': {
        var n = Number(descriptor.value)
        if (isNaN(n)) throw new Error('不是合法数字: ' + descriptor.value)
        return n
      }
      case 'boolean': return descriptor.value === true || descriptor.value === 'true'
      case 'bigint': return BigInt(descriptor.value)
      case 'null': return null
      case 'undefined': return undefined
      case 'json': {
        var text = String(descriptor.value == null ? '' : descriptor.value).trim()
        if (!text) throw new Error('JSON 不能为空')
        return JSON.parse(text)
      }
      default: return descriptor.value
    }
  }

  function setComponentState(uid, source, path, descriptor) {
    var vm = hook && hook.getInstance(uid)
    if (!vm) return { ok: false, error: '组件实例已销毁' }

    // props 来自父组件,属于只读数据;仅允许修改组件自身的响应式 data
    if (source !== 'data') {
      return { ok: false, error: 'props 为只读数据,不允许修改(仅 data 可编辑)' }
    }

    var root = vm.data
    if (!root || typeof root !== 'object') {
      return { ok: false, error: source + ' 不是可编辑对象' }
    }
    if (!Array.isArray(path)) {
      return { ok: false, error: 'path 不合法' }
    }

    var newValue = parseDescriptor(descriptor)

    // 空 path:整体替换 data 根对象
    // 逐键增删而非替换 vm.data 引用,保证响应式仍按字段粒度触发更新
    if (!path.length) {
      if (!isPlainObject(newValue)) {
        return { ok: false, error: 'data 根必须是一个对象' }
      }
      try {
        var oldKeys = Object.keys(root)
        for (var d = 0; d < oldKeys.length; d++) {
          if (!Object.prototype.hasOwnProperty.call(newValue, oldKeys[d])) delete root[oldKeys[d]]
        }
        var newKeys = Object.keys(newValue)
        for (var n = 0; n < newKeys.length; n++) root[newKeys[n]] = newValue[newKeys[n]]
      } catch (e) {
        return { ok: false, error: '写入失败: ' + ((e && e.message) || String(e)) }
      }

      pushTimeline({
        event: 'component:state-change',
        uid: uid,
        name: (state.meta.get(uid) || {}).name || vm.name,
        path: source + '(整体替换)',
        timestamp: now()
      })
      return { ok: true, value: serializeValue(newValue, 0, []) }
    }

    var parent = root
    for (var i = 0; i < path.length - 1; i++) {
      parent = safeGet(parent, path[i])
      if (parent === null || parent === undefined) {
        return { ok: false, error: '路径不存在: ' + path.slice(0, i + 1).join('.') }
      }
    }

    var key = path[path.length - 1]

    try {
      if (Array.isArray(parent) && key === 'length') {
        parent.length = newValue
      } else {
        parent[key] = newValue
      }
    } catch (e) {
      return { ok: false, error: '写入失败: ' + ((e && e.message) || String(e)) }
    }

    pushTimeline({
      event: 'component:state-change',
      uid: uid,
      name: (state.meta.get(uid) || {}).name || vm.name,
      path: source + '.' + path.join('.'),
      timestamp: now()
    })

    return { ok: true, value: serializeValue(newValue, 0, []) }
  }

  function deleteComponentState(uid, source, path) {
    var vm = hook && hook.getInstance(uid)
    if (!vm) return { ok: false, error: '组件实例已销毁' }

    // 与编辑保持一致:props 只读
    if (source !== 'data') {
      return { ok: false, error: 'props 为只读数据,不允许删除(仅 data 可编辑)' }
    }

    var root = vm.data
    if (!root || !path || path.length < 1) return { ok: false, error: '参数不合法' }
    var parent = root
    for (var i = 0; i < path.length - 1; i++) {
      parent = safeGet(parent, path[i])
      if (parent === null || parent === undefined) return { ok: false, error: '路径不存在' }
    }
    var key = path[path.length - 1]
    try {
      if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key]
    } catch (e) {
      return { ok: false, error: ((e && e.message) || String(e)) }
    }
    return { ok: true }
  }

  /**
   * 为「未定义 data」的组件初始化一个空的响应式 data 对象
   *
   * bindview 在 config.data 未定义时会把 vm.data 置为 null(见 Init.js),
   * 此时无法新增属性。这里复用框架自身的代理工厂 vm._DataProxy({}),
   * 保证新对象同样是响应式的(写入会经调度器触发 render + diff)。
   *
   * @returns {Object} { ok, existed, error }
   */
  function initComponentData(uid) {
    var vm = hook && hook.getInstance(uid)
    if (!vm) return { ok: false, error: '组件实例已销毁' }

    if (vm.data && typeof vm.data === 'object') {
      return { ok: true, existed: true }
    }
    if (typeof vm._DataProxy !== 'function') {
      return { ok: false, error: '当前 bindview 版本未暴露 _DataProxy,无法初始化 data' }
    }

    try {
      // 必须用 call(vm) 调用:DataProxy 以 this 作为组件实例来创建并缓存代理
      vm.data = vm._DataProxy.call(vm, {})
    } catch (e) {
      return { ok: false, error: '初始化失败: ' + ((e && e.message) || String(e)) }
    }

    pushTimeline({
      event: 'component:state-change',
      uid: uid,
      name: (state.meta.get(uid) || {}).name || vm.name,
      path: 'data(初始化)',
      timestamp: now()
    })
    scheduleRouterInfo()
    return { ok: true, existed: false }
  }

  /**
   * 调用组件方法(面板「调用」按钮)
   * 通过 vm.methods 上的绑定函数执行,等价于在页面内调用 this.methodName()
   */
  function invokeComponentMethod(uid, name, args) {
    var vm = hook && hook.getInstance(uid)
    if (!vm) return { ok: false, error: '组件实例已销毁' }

    var methods = safeGet(vm, 'methods')
    var fn = methods ? safeGet(methods, name) : null
    if (typeof fn !== 'function') return { ok: false, error: '方法不存在: ' + name }

    var list = Array.isArray(args) ? args : []
    var started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

    var result
    try {
      result = fn.apply(null, list)
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }

    var ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

    pushTimeline({
      event: 'component:method-call',
      uid: uid,
      name: name + '()',
      path: '参数 ' + list.length + ' 个',
      timestamp: now()
    })

    return {
      ok: true,
      duration: ended - started,
      result: serializeValue(result, 0, [])
    }
  }

  /* ------------------------------------------------------------------ */
  /* 高亮遮罩                                                            */
  /* ------------------------------------------------------------------ */

  function ensureOverlay() {
    if (overlay && overlay.parentNode) return
    overlay = document.createElement('div')
    overlay.setAttribute('data-bindview-devtools-overlay', '')
    var s = overlay.style
    s.position = 'fixed'
    s.zIndex = '2147483646'
    s.pointerEvents = 'none'
    s.background = 'rgba(65, 184, 131, 0.18)'
    s.border = '1px solid #41b883'
    s.borderRadius = '2px'
    s.boxSizing = 'border-box'
    s.display = 'none'

    overlayLabel = document.createElement('div')
    overlayLabel.setAttribute('data-bindview-devtools-label', '')
    var ls = overlayLabel.style
    ls.position = 'fixed'
    ls.zIndex = '2147483647'
    ls.pointerEvents = 'none'
    ls.padding = '1px 6px'
    ls.fontSize = '11px'
    ls.lineHeight = '16px'
    ls.fontFamily = 'Menlo, Consolas, monospace'
    ls.color = '#fff'
    ls.background = '#41b883'
    ls.borderRadius = '3px'
    ls.whiteSpace = 'nowrap'
    ls.display = 'none'

    document.documentElement.appendChild(overlay)
    document.documentElement.appendChild(overlayLabel)
  }

  function positionOverlay(el, name) {
    ensureOverlay()
    var rect = el.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideOverlay()
      return
    }
    overlay.style.display = 'block'
    overlay.style.left = rect.left + 'px'
    overlay.style.top = rect.top + 'px'
    overlay.style.width = rect.width + 'px'
    overlay.style.height = rect.height + 'px'

    overlayLabel.style.display = 'block'
    overlayLabel.textContent = name || ''
    overlayLabel.style.left = rect.left + 'px'
    overlayLabel.style.top = Math.max(0, rect.top - 18) + 'px'
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none'
    if (overlayLabel) overlayLabel.style.display = 'none'
  }

  function refreshOverlay() {
    if (overlayTarget === null) return
    var vm = hook && hook.getInstance(overlayTarget)
    if (!vm || !(vm.el instanceof HTMLElement)) {
      clearHighlight()
      return
    }
    var meta = state.meta.get(overlayTarget)
    positionOverlay(vm.el, (meta && meta.name) || vm.name || '')
  }

  function boundRefreshOverlay() {
    refreshOverlay()
  }

  function attachOverlayListeners() {
    window.addEventListener('scroll', boundRefreshOverlay, true)
    window.addEventListener('resize', boundRefreshOverlay, true)
  }

  function detachOverlayListeners() {
    window.removeEventListener('scroll', boundRefreshOverlay, true)
    window.removeEventListener('resize', boundRefreshOverlay, true)
  }

  function setHighlightEnabled(enabled) {
    state.highlightEnabled = !!enabled
    if (!state.highlightEnabled) clearHighlight()
    post('highlight:changed', { enabled: state.highlightEnabled })
    return state.highlightEnabled
  }

  function highlightComponent(uid, respectToggle) {
    if (respectToggle && !state.highlightEnabled) return false
    var vm = hook && hook.getInstance(uid)
    if (!vm || !(vm.el instanceof HTMLElement)) {
      clearHighlight()
      return false
    }
    if (overlayTarget !== null && overlayTarget !== uid) {
      // 切换目标无需重建监听
    }
    overlayTarget = uid
    state.highlightedUid = uid
    var meta = state.meta.get(uid)
    positionOverlay(vm.el, (meta && meta.name) || vm.name || '')
    attachOverlayListeners()
    return true
  }

  function clearHighlight() {
    overlayTarget = null
    state.highlightedUid = null
    detachOverlayListeners()
    hideOverlay()
    return true
  }

  function scrollToComponent(uid) {
    var vm = hook && hook.getInstance(uid)
    if (!vm || !(vm.el instanceof HTMLElement)) return false
    try {
      vm.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    } catch (e) {
      vm.el.scrollIntoView()
    }
    return true
  }

  /* ------------------------------------------------------------------ */
  /* 路由插件信息(bindview-router)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * 获取路由插件实例:
   * 优先读 Hook 上挂载的实例,其次从任意组件实例的原型链上取
   * (插件通过 Component.prototype.Router 暴露实例)
   */
  function getRouterInstance() {
    if (hook && hook.router && hook.router.router) return hook.router.router
    if (hook && hook.instances) {
      var found = null
      hook.instances.forEach(function (vm) {
        if (!found && vm && safeGet(vm, 'Router')) found = safeGet(vm, 'Router')
      })
      return found
    }
    return null
  }

  /** query 归一化为可跨进程传递的纯数据 */
  function normalizeQuery(query) {
    if (!query || typeof query !== 'object') return null
    var out = {}
    var keys = Object.keys(query)
    for (var i = 0; i < keys.length; i++) {
      var value = safeGet(query, keys[i])
      if (value === null || value === undefined) out[keys[i]] = null
      else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[keys[i]] = value
      else out[keys[i]] = truncate(String(value), 60)
    }
    return out
  }

  function safeLocation(key) {
    try {
      return typeof location !== 'undefined' ? String(location[key] || '') : ''
    } catch (e) {
      return ''
    }
  }

  /** 依据 newURL 与当前地址推断路由模式(hash / history) */
  function inferMode(instance) {
    if (!instance) return routerState.mode
    try {
      var hash = decodeURIComponent((safeLocation('hash') || '').replace(/^#/, ''))
      var hashPath = hash.split('?')[0]
      if (instance.newURL && hashPath === instance.newURL) return 'hash'
      var pathname = safeLocation('pathname')
      if (instance.newURL && pathname && pathname.indexOf(instance.newURL) === 0) return 'history'
    } catch (e) {
      /* ignore */
    }
    return routerState.mode
  }

  /**
   * 收集 Switch 组件,重建每一级实际命中的路由
   * Switch 的 data.path 即该 rank 级别匹配到的路径前缀
   */
  function collectRouteLevels() {
    var levels = []
    state.order.forEach(function (uid) {
      var meta = state.meta.get(uid)
      if (!meta || meta.name !== 'Switch') return

      var vm = hook && hook.getInstance(uid)
      var props = vm ? safeGet(vm, '_props') : null
      var data = vm ? safeGet(vm, 'data') : null
      var asyncMap = props ? safeGet(props, 'async') : null
      var levelPath = (data ? String(safeGet(data, 'path') || '') : '') || '/'
      var entry = findTableEntry(levelPath)

      levels.push({
        uid: uid,
        rank: props && safeGet(props, 'rank') !== undefined ? safeGet(props, 'rank') : null,
        path: levelPath,
        // 该级别命中路径在路由表中对应的组件
        component: entry ? entry.component : null,
        guard: !!(props && typeof safeGet(props, 'defend') === 'function'),
        async: !!(asyncMap && typeof asyncMap === 'object' && Object.keys(asyncMap).length > 0),
        asyncKeys: asyncMap && typeof asyncMap === 'object' ? Object.keys(asyncMap) : [],
        className: (props && safeGet(props, 'className')) || ''
      })
    })
    levels.sort(function (a, b) {
      var ra = typeof a.rank === 'number' ? a.rank : 9999
      var rb = typeof b.rank === 'number' ? b.rank : 9999
      return ra - rb
    })
    return levels
  }

  /**
   * 组件在组件树上的路由标注
   * Switch → 该级别命中的路径;Link → 跳转目标
   * @returns {Object|null} { kind, label }
   */
  function routeBadgeFor(vm, meta) {
    if (!vm || !meta) return null
    var props = safeGet(vm, '_props')

    if (meta.name === 'Switch') {
      var data = safeGet(vm, 'data')
      var path = data ? String(safeGet(data, 'path') || '') : ''
      return { kind: 'switch', label: path || '/' }
    }

    if (meta.name === 'Link') {
      var to = props ? safeGet(props, 'to') : null
      var target = ''
      if (to && typeof to === 'object') target = String(safeGet(to, 'to') || '')
      else if (to !== undefined && to !== null) target = String(to)
      return target ? { kind: 'link', label: target } : null
    }

    return null
  }

  /**
   * 单个组件的路由分区(展示在检查器中,只读)
   */
  function buildRouteSection(vm) {
    var instance = getRouterInstance()

    // 仅路由相关组件(Switch / Link)展示路由分区
    if (!instance || !vm) return null
    var name = safeGet(vm, 'name')
    if (name !== 'Switch' && name !== 'Link') return null

    var rows = []
    rows.push({ key: '当前路由', value: String(instance.newURL || '/') })
    if (instance.oldURL) rows.push({ key: '上一路由', value: String(instance.oldURL) })

    var query = normalizeQuery(instance.query)
    rows.push({
      key: '查询参数',
      value: query && Object.keys(query).length ? JSON.stringify(query) : '—'
    })
    rows.push({ key: '路由模式', value: routerState.mode || inferMode(instance) || '未知' })

    if (name === 'Switch') {
      var props = safeGet(vm, '_props')
      var data = safeGet(vm, 'data')
      var asyncMap = props ? safeGet(props, 'async') : null

      rows.push({
        key: '路由级别',
        value: 'rank ' + (props && safeGet(props, 'rank') !== undefined ? safeGet(props, 'rank') : '?')
      })
      rows.push({
        key: '命中路径',
        value: (data ? String(safeGet(data, 'path') || '') : '') || '/'
      })
      rows.push({
        key: '路由守卫',
        value: props && typeof safeGet(props, 'defend') === 'function' ? '已启用' : '未启用'
      })
      rows.push({
        key: '异步组件',
        value: asyncMap && typeof asyncMap === 'object' && Object.keys(asyncMap).length
          ? Object.keys(asyncMap).join(', ')
          : '无'
      })
    } else {
      var linkProps = safeGet(vm, '_props')
      var to = linkProps ? safeGet(linkProps, 'to') : null
      var target = to && typeof to === 'object' ? String(safeGet(to, 'to') || '') : (to == null ? '' : String(to))

      rows.push({ key: '跳转目标', value: target || '—' })

      var linkData = safeGet(vm, 'data')
      rows.push({
        key: '当前激活',
        value: (linkData ? String(safeGet(linkData, 'path') || '') : '') || '/'
      })
    }

    return { id: 'route', label: '路由', rows: rows, editable: false }
  }

  /** 取当前生效的路由表集合(Hook 优先,其次本地缓存) */
  function routeTablesSource() {
    if (hook && Array.isArray(hook.routeTables) && hook.routeTables.length) return hook.routeTables
    return routerState.tables || []
  }

  /** 依据 path 在路由表中查找到对应条目 { path, component } */
  function findTableEntry(path) {
    if (!path) return null
    var tables = routeTablesSource()
    for (var i = 0; i < tables.length; i++) {
      var entries = tables[i] && tables[i].entries
      if (!Array.isArray(entries)) continue
      for (var j = 0; j < entries.length; j++) {
        if (entries[j] && entries[j].path === path) return entries[j]
      }
    }
    return null
  }

  /** 当前路由地址(实例优先,其次本地缓存) */
  function currentRoutePath() {
    var instance = getRouterInstance()
    if (instance && instance.newURL) return String(instance.newURL)
    return routerState.current.newURL || ''
  }

  /** 页面标题(截断,避免过长) */
  function pageTitle() {
    try {
      return truncate(document.title || '', 80)
    } catch (e) {
      return ''
    }
  }

  /**
   * 聚合当前路由信息(面板「路由」页签的数据源)
   */
  function buildRouterInfo() {
    var instance = getRouterInstance()
    var plugin = (hook && hook.router) || null
    var currentPath = currentRoutePath()
    var entry = findTableEntry(currentPath)
    var nav = routerState.navigation
    var pointer = routerState.pointer

    return {
      installed: !!(instance || routerState.installed),
      mode: routerState.mode || inferMode(instance),
      version: routerState.version || (plugin && plugin.version) || null,
      title: pageTitle(),
      current: {
        oldURL: instance ? String(instance.oldURL || '') : routerState.current.oldURL,
        newURL: currentPath || routerState.current.newURL,
        query: instance ? normalizeQuery(instance.query) : routerState.current.query
      },
      // 当前地址在路由表中命中的组件条目
      rendered: entry ? { path: entry.path, component: entry.component } : null,
      levels: collectRouteLevels(),
      tables: routeTablesSource(),
      navigation: nav.slice(),
      // 导航历史指针与前进 / 后退可用性(驱动面板按钮禁用态)
      pointer: pointer,
      canGoBack: pointer > 0,
      canGoForward: pointer >= 0 && pointer < nav.length - 1,
      location: {
        href: safeLocation('href'),
        pathname: safeLocation('pathname'),
        search: safeLocation('search'),
        hash: safeLocation('hash')
      }
    }
  }

  function scheduleRouterInfo() {
    if (routerTimer) return
    routerTimer = setTimeout(function () {
      routerTimer = null
      post('router:info', buildRouterInfo())
    }, 50)
  }

  function onRouterInit(payload) {
    if (!payload) return
    routerState.installed = true
    routerState.mode = payload.mode || null
    routerState.version = payload.version || null
    routerState.current = {
      oldURL: payload.oldURL || '',
      newURL: payload.newURL || '',
      query: normalizeQuery(payload.query)
    }
    pushTimeline({
      event: 'route:init',
      name: 'bindview-router',
      path: '模式 ' + (payload.mode || 'unknown') + (payload.version ? ' v' + payload.version : ''),
      timestamp: now()
    })
    scheduleRouterInfo()
  }

  /**
   * 把一次路由变更并入导航历史模型(模拟浏览器前进 / 后退栈)
   *
   *  - 命中历史中更早的位置 → 后退
   *  - 命中历史中更晚的位置 → 前进
   *  - 否则视为新导航:截断指针之后的前进栈再追加
   */
  function onRouterNavigate(payload) {
    if (!payload) return
    var next = {
      oldURL: payload.oldURL || '',
      newURL: payload.newURL || '',
      query: normalizeQuery(payload.query),
      timestamp: payload.timestamp || now()
    }
    routerState.installed = true
    routerState.current = { oldURL: next.oldURL, newURL: next.newURL, query: next.query }

    var nav = routerState.navigation
    var pointer = routerState.pointer

    // 多个 Switch 初始化时会各自 emit 一次;命中已有位置(地址与 query 均相同)即视为重复触发
    var existing = -1
    for (var i = 0; i < nav.length; i++) {
      if (nav[i].newURL === next.newURL &&
        JSON.stringify(nav[i].query || null) === JSON.stringify(next.query || null)) {
        existing = i
        break
      }
    }

    if (existing > -1) {
      routerState.pointer = existing
      scheduleRouterInfo()
      return
    }

    // 新导航:丢弃指针之后的前进栈
    if (pointer < nav.length - 1) nav.length = pointer + 1
    nav.push(next)
    if (nav.length > 100) nav.shift()
    routerState.pointer = nav.length - 1

    pushTimeline({
      event: 'route:navigate',
      name: next.newURL || '/',
      path: (next.oldURL || '/') + ' → ' + (next.newURL || '/'),
      timestamp: next.timestamp
    })
    scheduleRouterInfo()
  }

  function onRouterTable(payload) {
    if (!payload || !Array.isArray(payload.tables)) return
    routerState.tables = payload.tables
    scheduleRouterInfo()
  }

  /** Hook 就绪时同步一次路由信息(覆盖路由插件先于扩展加载的情况) */
  function syncRouterFromHook() {
    if (hook && hook.router) {
      routerState.installed = true
      routerState.mode = hook.router.mode || routerState.mode
      routerState.version = hook.router.version || routerState.version
      var instance = hook.router.router
      if (instance) {
        routerState.current = {
          oldURL: String(instance.oldURL || ''),
          newURL: String(instance.newURL || ''),
          query: normalizeQuery(instance.query)
        }
      }
    }
    if (hook && Array.isArray(hook.routeTables)) routerState.tables = hook.routeTables
    scheduleRouterInfo()
  }

  /** 编程式导航(面板「跳转」) */
  function routerNavigate(params) {
    var instance = getRouterInstance()
    if (!instance || typeof instance.$to !== 'function') {
      return { ok: false, error: '未检测到 bindview-router 插件' }
    }
    var path = String((params && params.path) || '').trim()
    if (!path) return { ok: false, error: 'path 不能为空' }

    var query = params && params.query && typeof params.query === 'object' ? params.query : {}
    try {
      instance.$to(path, query)
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
    // 时间线由 Bus 派发的 router:navigate 事件统一记录,这里不再手动写入以免重复
    scheduleRouterInfo()
    return { ok: true }
  }

  /** 会话历史前进 / 后退 / 相对跳转 */
  function routerAction(params) {
    var instance = getRouterInstance()
    if (!instance) return { ok: false, error: '未检测到 bindview-router 插件' }

    var action = (params && params.action) || ''
    try {
      if (action === 'back' && typeof instance.$back === 'function') instance.$back()
      else if (action === 'forward' && typeof instance.$forward === 'function') instance.$forward()
      else if (action === 'go' && typeof instance.$go === 'function') instance.$go(Number((params && params.n) || 0))
      else return { ok: false, error: '未知操作: ' + action }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
    scheduleRouterInfo()
    return { ok: true }
  }

  /* ------------------------------------------------------------------ */
  /* RPC 分发                                                            */
  /* ------------------------------------------------------------------ */

  var rpcHandlers = {
    rescan: function () {
      return { ok: true, count: fullRescan() }
    },
    getTree: function () {
      return buildTree()
    },
    inspect: function (params) {
      return inspectComponent(params.uid)
    },
    setState: function (params) {
      return setComponentState(params.uid, params.source, params.path, params.value)
    },
    deleteState: function (params) {
      return deleteComponentState(params.uid, params.source, params.path)
    },
    getRawJson: function (params) {
      return getRawJson(params.uid, params.source, params.path)
    },
    initData: function (params) {
      return initComponentData(params.uid)
    },
    exposeInstance: function (params) {
      var vm = hook && hook.getInstance(params.uid)
      if (!vm) return { ok: false, error: '组件实例已销毁' }
      // 把真实实例挂到页面 window,便于在控制台直接以 $vm 操作
      try {
        window.$vm = vm
        window.$bv = vm
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
      return { ok: true, name: vm.name || '' }
    },
    invokeMethod: function (params) {
      return invokeComponentMethod(params.uid, params.name, params.args)
    },
    highlight: function (params) {
      return { ok: highlightComponent(params.uid, false) }
    },
    hover: function (params) {
      return { ok: highlightComponent(params.uid, true) }
    },
    unhighlight: function () {
      return { ok: clearHighlight() }
    },
    scrollTo: function (params) {
      return { ok: scrollToComponent(params.uid) }
    },
    setHighlightEnabled: function (params) {
      return { enabled: setHighlightEnabled(params.enabled) }
    },
    getTimeline: function () {
      return state.timeline.slice(-200)
    },
    clearTimeline: function () {
      state.timeline = []
      return { ok: true }
    },
    getRouterInfo: function () {
      return buildRouterInfo()
    },
    routerNavigate: function (params) {
      return routerNavigate(params)
    },
    routerAction: function (params) {
      return routerAction(params)
    },
    clearNavigation: function () {
      routerState.navigation = []
      routerState.pointer = -1
      scheduleRouterInfo()
      return { ok: true }
    }
  }

  function handleRpc(message) {
    var id = message.id
    var method = message.method
    var handler = rpcHandlers[method]
    if (typeof handler !== 'function') {
      post('rpc:response', { id: id, error: '未知方法: ' + method })
      return
    }
    try {
      post('rpc:response', { id: id, result: handler(message.params || {}) })
    } catch (e) {
      post('rpc:response', { id: id, error: (e && e.message) || String(e) })
    }
  }

  /* ------------------------------------------------------------------ */
  /* 收 / 发消息                                                         */
  /* ------------------------------------------------------------------ */

  function handleMessage(message) {
    switch (message.type) {
      case 'panel:connected':
        state.panelConnected = true
        sendTree()
        post('timeline:list', state.timeline.slice(-200))
        post('highlight:changed', { enabled: state.highlightEnabled })
        post('router:info', buildRouterInfo())
        break
      case 'panel:refresh':
        fullRescan()
        break
      case 'highlight:enable':
        setHighlightEnabled(message.data ? message.data.enabled : false)
        break
      case 'bindview:status:request':
        // 后台在内容脚本上线 / SW 重启后主动请求:立即回传当前检测状态
        // (决定工具栏图标是彩色还是灰色)
        post('bindview:status', { count: state.order.length })
        break
      case 'action:probe':
        // 工具栏图标点击:全量扫描后回传组件数量
        post('action:probe:result', { count: fullRescan() })
        break
      case 'rpc':
        handleRpc(message)
        break
      default:
        break
    }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return
    var data = ev.data
    if (!data || data.source !== SOURCE || data.direction !== 'to-page') return
    if (!data.payload || !data.payload.type) return

    // 收到来自扩展的任意指令即视为面板在线(兜底 panel:connected 因时序丢失)
    state.panelConnected = true
    handleMessage(data.payload)
  })

  /* ------------------------------------------------------------------ */
  /* 连接全局 Hook                                                       */
  /* ------------------------------------------------------------------ */

  function bindHook(nextHook) {
    if (!nextHook || hook === nextHook) return
    hook = nextHook

    // 清理旧订阅
    for (var i = 0; i < unsubscribers.length; i++) {
      try { unsubscribers[i]() } catch (e) { /* ignore */ }
    }
    unsubscribers = []

    unsubscribers.push(hook.on('component:added', function (payload) { onComponentAdded(payload, false) }))
    unsubscribers.push(hook.on('component:updated', function (payload) { onComponentUpdated(payload) }))
    unsubscribers.push(hook.on('component:removed', function (payload) { onComponentRemoved(payload) }))
    unsubscribers.push(hook.on('app:rescan', function (payload) { onRescan(payload) }))
    unsubscribers.push(hook.on('router:init', function (payload) { onRouterInit(payload) }))
    unsubscribers.push(hook.on('router:navigate', function (payload) { onRouterNavigate(payload) }))
    unsubscribers.push(hook.on('router:table', function (payload) { onRouterTable(payload) }))

    // 启用 Hook,回放其缓存的事件(可能包含应用初始化阶段的事件)
    hook.enable()
    scheduleTree()
    syncRouterFromHook()
    post('backend:ready', { hookVersion: hook.version })
  }

  window.addEventListener(INSTALL_EVENT, function (ev) {
    bindHook(ev.detail)
  })

  var existingHook = window[HOOK_NAME]
  if (existingHook) {
    bindHook(existingHook)
  } else {
    // hook.js 与 index.js 同批注入,正常情况下此处已存在;
    // 若因扩展注入顺序异常而未就绪,短暂轮询兜底。
    var tries = 0
    var timer = setInterval(function () {
      tries++
      var h = window[HOOK_NAME]
      if (h) {
        clearInterval(timer)
        bindHook(h)
      } else if (tries > 100) {
        clearInterval(timer)
      }
    }, 50)
  }

  window.addEventListener('beforeunload', function () {
    detachOverlayListeners()
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    if (overlayLabel && overlayLabel.parentNode) overlayLabel.parentNode.removeChild(overlayLabel)
  })
})()
