import { el, clear, formatTime, debounce } from '../lib/dom.js'

/**
 * 路由视图(bindview-router)
 * ------------------------------------------------------------------
 * 展示:插件状态 / 当前路由与命中组件 / 各级 Switch 命中路径 / 路由表 / 导航历史,
 * 并支持搜索过滤、高亮当前命中、URL 智能解析、历史下拉、前进后退禁用态与编程式导航。
 */

function kv(label, value) {
  return el('div', { class: 'bv-kv' }, [
    el('span', { class: 'bv-kv-key', text: label }),
    el('span', { class: 'bv-kv-value', text: value })
  ])
}

function sectionWrap(label, badge, body) {
  return el('section', { class: 'bv-section' }, [
    el('div', { class: 'bv-section-title' }, [
      el('span', { class: 'bv-section-label', text: label }),
      badge !== null && badge !== undefined
        ? el('span', { class: 'bv-section-badge', text: String(badge) })
        : null
    ]),
    body
  ])
}

/** 组件描述 → 展示名 */
function componentName(component) {
  return component && component.name ? component.name : ''
}

/** 组件描述 → 展示文案(形如 /A · <CompA>) */
function componentText(entry) {
  if (!entry) return '—'
  const name = componentName(entry.component)
  return name ? entry.path + ' · <' + name + '>' : entry.path
}

/**
 * 把用户输入解析为 { path, query }
 * 支持: /A、A、#/A?id=1、/A?id=1、完整 URL(http://x/#/A?id=1 或 http://x/A?id=1)
 */
function parseNavigationInput(raw) {
  let text = String(raw || '').trim()
  if (!text) return { path: '', query: null }

  if (/^[a-z]+:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      if (url.hash && url.hash.length > 1) text = url.hash.slice(1)
      else text = url.pathname + url.search
    } catch (e) {
      /* 解析失败则按原文本处理 */
    }
  } else if (text.charAt(0) === '#') {
    text = text.slice(1)
  }

  let path = text
  let query = null
  const qIndex = text.indexOf('?')
  if (qIndex > -1) {
    path = text.slice(0, qIndex)
    query = {}
    try {
      const params = new URLSearchParams(text.slice(qIndex + 1))
      params.forEach(function (value, key) { query[key] = value })
    } catch (e) {
      query = null
    }
  }

  if (path && path.charAt(0) !== '/') path = '/' + path
  return { path: path, query: query }
}

/** 导航操作表单(只创建一次,避免信息刷新时打断输入) */
function createNavForm(api) {
  const pathInput = el('input', {
    class: 'bv-input',
    type: 'text',
    list: 'bv-route-paths',
    placeholder: '路径或完整 URL,如 /A 或 #/A?id=1'
  })
  const queryInput = el('input', {
    class: 'bv-input bv-input--query',
    type: 'text',
    placeholder: 'query JSON(可选),填写则覆盖地址中的 query'
  })
  const goInput = el('input', {
    class: 'bv-input bv-input--go',
    type: 'number',
    value: '0',
    title: '相对当前历史位置跳转,等价于 Router.$go(n)'
  })
  const hint = el('span', { class: 'bv-nav-hint', text: '' })
  const datalist = el('datalist', { id: 'bv-route-paths' })

  function setHint(text, isError) {
    hint.textContent = text || ''
    hint.className = 'bv-nav-hint' + (isError ? ' bv-nav-hint--error' : '')
  }

  function go() {
    const parsed = parseNavigationInput(pathInput.value)
    if (!parsed.path || parsed.path === '/') {
      setHint('请输入有效的路由路径', true)
      return
    }

    let query = parsed.query || {}
    const rawQuery = queryInput.value.trim()
    if (rawQuery) {
      try {
        query = JSON.parse(rawQuery)
      } catch (e) {
        setHint('query 不是合法 JSON', true)
        return
      }
    }

    api.routerNavigate(parsed.path, query)
    setHint('已跳转 ' + parsed.path)
  }

  pathInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') go()
  })
  queryInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') go()
  })
  goInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') api.routerGo(Number(goInput.value) || 0)
  })

  const backBtn = el('button', {
    class: 'bv-btn bv-btn--sm',
    title: '返回上一路由 Router.$back()',
    onclick: function () { api.routerAction('back') }
  }, '后退')

  const forwardBtn = el('button', {
    class: 'bv-btn bv-btn--sm',
    title: '前进到下一路由 Router.$forward()',
    onclick: function () { api.routerAction('forward') }
  }, '前进')

  const root = el('div', { class: 'bv-router-nav' }, [
    el('span', { class: 'bv-router-nav-title', text: '导航' }),
    pathInput,
    queryInput,
    el('button', { class: 'bv-btn bv-btn--sm bv-btn--primary', onclick: go }, '跳转'),
    backBtn,
    forwardBtn,
    el('span', { class: 'bv-route-go' }, [
      goInput,
      el('button', {
        class: 'bv-btn bv-btn--sm',
        title: '相对当前历史位置跳转 Router.$go(n)',
        onclick: function () { api.routerGo(Number(goInput.value) || 0) }
      }, '$go')
    ]),
    hint,
    datalist
  ])

  let lastPathKey = null

  /** 依据最新路由信息更新按钮禁用态与路径建议(不打断输入) */
  function update(info, paths) {
    backBtn.disabled = !(info && info.canGoBack)
    forwardBtn.disabled = !(info && info.canGoForward)

    const key = paths.join('|')
    if (key === lastPathKey) return
    lastPathKey = key
    clear(datalist)
    paths.slice(0, 200).forEach(function (path) {
      datalist.appendChild(el('option', { value: path }))
    })
  }

  return { el: root, update: update }
}

/**
 * 「当前组件」文案
 *
 * 无法给出组件时说明原因,避免只显示一个无从判断的 `—`:
 *  - 有路由表但当前路径未命中 → 路径与路由表不匹配
 *  - 没有路由表 → 应用未使用 CreateRouterTable(如 Switch + render-prop 手写映射),
 *    且当前也没有命中的 Switch 组件可供推断
 */
function renderedText(info) {
  const text = componentText(info.rendered)
  if (text !== '—') return text
  const hasTables = (info.tables || []).length > 0
  return hasTables
    ? '—(当前路径未命中路由表)'
    : '—(未注册路由表,且无可推断的 Switch 组件)'
}

function overviewSection(info) {
  const current = info.current || {}
  const rows = [
    kv('当前路由', current.newURL || '/'),
    kv('上一路由', current.oldURL || '—'),
    kv('查询参数', current.query && Object.keys(current.query).length ? JSON.stringify(current.query) : '—'),
    kv('路由模式', info.mode || '未知'),
    kv('插件版本', info.version ? 'v' + info.version : '—'),
    kv('当前组件', renderedText(info)),
    kv('页面标题', info.title || '—'),
    kv('浏览器地址', (info.location && info.location.href) || '—')
  ]
  if (info.location && info.location.hash) rows.push(kv('location.hash', info.location.hash))

  return sectionWrap('路由状态', 'bindview-router', el('div', { class: 'bv-router-kv' }, rows))
}

/** 该级别 Switch 是否命中当前路由 */
function isLevelActive(level, currentURL) {
  if (!currentURL) return false
  if (!level.path) return false
  if (level.path === '/') return true
  return currentURL === level.path || currentURL.indexOf(level.path + '/') === 0 || currentURL.indexOf(level.path + '?') === 0
}

function levelsSection(info, api) {
  const body = el('div', { class: 'bv-route-levels' })
  const levels = info.levels || []
  const currentURL = (info.current && info.current.newURL) || ''

  if (!levels.length) {
    body.appendChild(el('div', { class: 'bv-entry bv-entry--empty', text: '未发现 Switch 组件' }))
  } else {
    levels.forEach(function (level) {
      const active = isLevelActive(level, currentURL)
      const name = componentName(level.component)
      body.appendChild(el('div', {
        class: 'bv-route-level' + (active ? ' bv-route-level--active' : ''),
        title: active ? '当前命中 · 点击查看该 Switch 组件' : '点击查看该 Switch 组件',
        onclick: function () { api.select(level.uid) }
      }, [
        el('span', { class: 'bv-rank', text: 'rank ' + (level.rank === null ? '?' : level.rank) }),
        el('span', { class: 'bv-route-path', text: level.path || '/' }),
        name ? el('span', { class: 'bv-chip bv-chip--component', text: '<' + name + '>' }) : null,
        level.guard ? el('span', { class: 'bv-chip bv-chip--warn', text: '守卫' }) : null,
        level.async ? el('span', { class: 'bv-chip', text: '异步:' + (level.asyncKeys || []).join(',') }) : null,
        level.className ? el('span', { class: 'bv-chip', text: '.' + level.className }) : null,
        active ? el('span', { class: 'bv-chip bv-chip--active-tag', text: '当前命中' }) : null
      ]))
    })
  }

  return sectionWrap('路由层级(Switch)', levels.length, body)
}

function tablesSection(info, api, keyword) {
  const body = el('div', {})
  const tables = info.tables || []
  const currentURL = (info.current && info.current.newURL) || ''

  // 归一化:优先 entries(含组件信息),回退到旧版 paths
  const normalized = tables.map(function (table) {
    const entries = Array.isArray(table.entries)
      ? table.entries
      : (table.paths || []).map(function (path) { return { path: path, component: null } })
    return entries
  })

  const total = normalized.reduce(function (sum, entries) { return sum + entries.length }, 0)
  if (!total) {
    body.appendChild(el('div', {
      class: 'bv-entry bv-entry--empty',
      text: '未注册路由表(通过 CreateRouterTable 创建的路由表会自动注册)'
    }))
    return sectionWrap('路由表', 0, body)
  }

  let shown = 0
  normalized.forEach(function (entries, index) {
    const filtered = keyword
      ? entries.filter(function (entry) {
        const name = componentName(entry.component)
        return entry.path.toLowerCase().indexOf(keyword) > -1 ||
          (name && name.toLowerCase().indexOf(keyword) > -1)
      })
      : entries

    if (!filtered.length) return
    shown += filtered.length

    const chips = el('div', { class: 'bv-chips' })
    filtered.forEach(function (entry) {
      const name = componentName(entry.component)
      const isCurrent = !!currentURL && entry.path === currentURL
      const title = (isCurrent ? '当前命中 · ' : '跳转到 ') + entry.path + (name ? ' · 组件 <' + name + '>' : '')
      chips.appendChild(el('span', {
        class: 'bv-chip bv-chip--path' + (isCurrent ? ' bv-chip--active' : ''),
        title: title,
        onclick: function () { api.routerNavigate(entry.path, {}) }
      }, [
        el('span', { class: 'bv-chip-path-text', text: entry.path }),
        name ? el('span', { class: 'bv-chip-component', text: name }) : null
      ]))
    })

    body.appendChild(el('div', { class: 'bv-table-box' }, [
      el('div', {
        class: 'bv-table-title',
        text: '路由表 #' + (index + 1) + ' · ' + entries.length + ' 条'
      }),
      chips
    ]))
  })

  if (!shown) {
    body.appendChild(el('div', { class: 'bv-entry bv-entry--empty', text: '没有匹配的路由路径' }))
  }

  return sectionWrap('路由表', keyword ? shown + ' / ' + total : total, body)
}

function historySection(info, api) {
  const nav = info.navigation || []
  const pointer = typeof info.pointer === 'number' ? info.pointer : nav.length - 1

  const head = el('div', { class: 'bv-route-history-head' }, [
    el('span', {
      class: 'bv-muted',
      text: nav.length ? '当前位于第 ' + (pointer + 1) + ' / ' + nav.length + ' 条' : '暂无导航记录'
    }),
    el('button', {
      class: 'bv-btn bv-btn--sm',
      title: '仅清空调试器记录,不影响浏览器会话历史',
      onclick: function () { api.routerClearHistory() }
    }, '清空')
  ])

  const list = el('div', { class: 'bv-route-history' })
  if (!nav.length) {
    list.appendChild(el('div', { class: 'bv-entry bv-entry--empty', text: '暂无导航记录' }))
  }
  nav.forEach(function (item, index) {
    const isCurrent = index === pointer
    list.appendChild(el('div', {
      class: 'bv-entry bv-route-history-row' + (isCurrent ? ' bv-route-history-row--current' : '')
    }, [
      el('span', { class: 'bv-event-time', text: formatTime(item.timestamp) }),
      el('span', { class: 'bv-route-path', text: (item.oldURL || '/') + ' → ' + (item.newURL || '/') }),
      item.query && Object.keys(item.query).length
        ? el('span', { class: 'bv-query', text: JSON.stringify(item.query) })
        : null
    ]))
  })

  return sectionWrap('导航历史', nav.length, el('div', { class: 'bv-route-history-box' }, [head, list]))
}

function emptyState() {
  return el('div', { class: 'bv-router-empty' }, [
    el('h3', { text: '未检测到 bindview-router' }),
    el('p', { class: 'bv-muted', text: '在应用中通过插件方式安装路由即可自动接入:' }),
    el('pre', { class: 'bv-code' }, [
      "import Bindview from 'bindview'\n",
      "import { hash, history } from 'bindview-router'\n\n",
      'Bindview.use(hash)      // hash 模式\n',
      'Bindview.use(history)   // history 模式\n',
      'Bindview.use([hash])    // hash 模式\n',
      'Bindview.use([history]) // history 模式'
    ]),
    el('p', { class: 'bv-muted', text: '安装后点击右上角「刷新」,或切换路由即可看到信息。' })
  ])
}

/** 收集全部已知路径(路由表 + 导航历史)作为输入建议 */
function collectPaths(info) {
  if (!info) return []
  const seen = new Set()
  const out = []
  function push(path) {
    if (!path || seen.has(path)) return
    seen.add(path)
    out.push(path)
  }

  ; (info.tables || []).forEach(function (table) {
    if (Array.isArray(table.entries)) table.entries.forEach(function (entry) { push(entry.path) })
    else (table.paths || []).forEach(push)
  })
    ; (info.navigation || []).forEach(function (item) { push(item.newURL) })

  return out
}

export function createRouterView(container, api) {
  const pane = el('div', { class: 'bv-view-body bv-router' })
  const navForm = createNavForm(api)

  const searchInput = el('input', {
    class: 'bv-input bv-input--search',
    type: 'text',
    placeholder: '过滤路径 / 组件名'
  })
  let keyword = ''
  searchInput.addEventListener('input', debounce(function () {
    keyword = searchInput.value.trim().toLowerCase()
    renderBody()
  }, 150))

  const toolbar = el('div', { class: 'bv-router-toolbar' }, [
    searchInput,
    el('span', { class: 'bv-muted', text: '按路径或组件名过滤路由表;点击路径可直接跳转' })
  ])

  const body = el('div', { class: 'bv-router-body' })
  pane.appendChild(navForm.el)
  pane.appendChild(toolbar)
  pane.appendChild(body)
  container.appendChild(pane)

  let lastRevision = null
  let lastInfo = null

  function renderBody() {
    clear(body)
    const info = lastInfo
    if (!info) {
      body.appendChild(el('div', { class: 'bv-empty', text: '正在读取路由信息…' }))
      return
    }
    if (!info.installed) {
      body.appendChild(emptyState())
      return
    }

    body.appendChild(overviewSection(info))
    body.appendChild(levelsSection(info, api))
    body.appendChild(tablesSection(info, api, keyword))
    body.appendChild(historySection(info, api))
  }

  function render(state) {
    if (lastRevision === state.routerRevision) return
    lastRevision = state.routerRevision
    lastInfo = state.routerInfo || null
    navForm.update(lastInfo, collectPaths(lastInfo))
    renderBody()
  }

  return { render: render }
}
