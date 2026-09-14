import { el, clear, debounce } from '../lib/dom.js'

/**
 * 过滤组件树:保留命中节点及其祖先
 */
function filterTree(node, keyword) {
  const name = (node.name || '').toLowerCase()
  const selfMatch = name.indexOf(keyword) > -1
  const children = []
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = filterTree(node.children[i], keyword)
      if (child) children.push(child)
    }
  }
  if (!selfMatch && children.length === 0) return null
  return Object.assign({}, node, { children: children })
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** 徽标正文:更新次数 · 最近渲染耗时(与检查器共用同一份 meta 数据) */
function badgeText(node) {
  const count = node.updateCount || 0
  if (!count) return ''
  return '×' + count + ' · ' + round(node.lastDuration) + 'ms'
}

/** 徽标提示:时间维度与检查器头部完全一致 */
function badgeTitle(node) {
  const count = node.updateCount || 0
  const total = round(node.totalDuration)
  return '更新 ' + count + ' 次\n' +
    '最近渲染 ' + round(node.lastDuration) + ' ms\n' +
    '平均 ' + round(count ? total / count : 0) + ' ms\n' +
    '累计 ' + total + ' ms'
}

/** 渲染更新统计徽标(仅统计有更新记录的组件) */
function renderUpdateBadge(node) {
  const text = badgeText(node)
  if (!text) return null
  return el('span', { class: 'bv-node-meta', text: text, title: badgeTitle(node) })
}

/** 生成节点行的选择器(uid 由框架生成,仍做转义以防特殊字符) */
function uidSelector(uid) {
  const value = String(uid)
  const safe = (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
  return '.bv-node[data-uid="' + safe + '"]'
}

export function createComponentTree(container, api) {
  const input = el('input', {
    class: 'bv-search-input',
    type: 'text',
    placeholder: '搜索组件名称'
  })
  const onInput = debounce(function () { api.setSearch(input.value.trim().toLowerCase()) }, 200)
  input.addEventListener('input', onInput)

  const expandAllBtn = el('button', {
    class: 'bv-btn bv-btn--sm',
    title: '展开全部节点',
    onclick: function () { api.expandAll() }
  }, '全展开')

  const collapseAllBtn = el('button', {
    class: 'bv-btn bv-btn--sm',
    title: '折叠全部节点',
    onclick: function () { api.collapseAll() }
  }, '全折叠')

  const treeBox = el('div', { class: 'bv-tree' })
  const pane = el('aside', { class: 'bv-tree-pane' }, [
    el('div', { class: 'bv-search' }, [
      input,
      el('div', { class: 'bv-tree-actions' }, [expandAllBtn, collapseAllBtn])
    ]),
    treeBox
  ])
  container.appendChild(pane)

  let lastRevision = null

  /* ------------------------- 布局尺寸切换 ------------------------- */
  // CSS 的 resize 由浏览器把拖拽结果写成元素「内联样式」(style="width:500px"),
  // 而内联样式优先级高于样式表规则,因此切换布局时若不清理,
  // 上下布局下 width:auto 会被残留的内联宽度压住(反之 height 同理)。
  // 这里在切换前记录当前布局的拖拽尺寸,清除内联值后再按需恢复另一种布局的尺寸。
  const paneSizes = { horizontal: null, vertical: null }
  let lastLayout = null

  function capturePaneSize(layout) {
    if (layout === 'vertical') {
      if (pane.style.height) paneSizes.vertical = pane.style.height
    } else if (pane.style.width) {
      paneSizes.horizontal = pane.style.width
    }
  }

  function applyPaneSize(layout) {
    if (layout === 'vertical') {
      // 清除水平布局遗留的内联宽度,让 CSS 的 width:auto 生效
      pane.style.width = ''
      pane.style.height = paneSizes.vertical || ''
    } else {
      pane.style.height = ''
      pane.style.width = paneSizes.horizontal || ''
    }
  }

  function syncLayout(layout) {
    const next = layout === 'vertical' ? 'vertical' : 'horizontal'
    if (next === lastLayout) return
    if (lastLayout) capturePaneSize(lastLayout)
    lastLayout = next
    applyPaneSize(next)
  }

  function renderNode(node, state, depth) {
    const hasChildren = node.children && node.children.length > 0
    const expanded = !!state.search || state.expanded.has(node.uid)
    const wrap = el('div', { class: 'bv-node-wrap' })

    const parts = [
      hasChildren
        ? el('span', {
          class: 'bv-arrow' + (expanded ? ' bv-arrow--open' : ''),
          text: expanded ? '▾' : '▸',
          onclick: function (e) { e.stopPropagation(); api.toggleExpand(node.uid) }
        })
        : el('span', { class: 'bv-arrow bv-arrow--leaf' }),
      // 组件名以 <Name> 形式展示,便于与普通 DOM 节点区分
      el('span', { class: 'bv-node-name', text: '<' + (node.name || 'AnonymousComponent') + '>' })
    ]

    // 路由相关组件(Switch / Link)在节点上标注路由信息
    if (node.route) {
      parts.push(el('span', {
        class: 'bv-node-route',
        text: node.route.label,
        title: node.route.kind === 'switch' ? 'Switch 命中路径' : 'Link 跳转目标'
      }))
    }

    // linkage: false —— 该组件不参与父组件的数据更新联动
    if (node.linkage === false) {
      parts.push(el('span', {
        class: 'bv-node-linkage',
        text: 'linkage:false',
        title: 'linkage: false —— 父组件更新时不会联动该组件更新'
      }))
    }

    const badge = renderUpdateBadge(node)
    if (badge) parts.push(badge)

    if (hasChildren) parts.push(el('span', { class: 'bv-node-count', text: String(node.children.length) }))

    const row = el('div', {
      class: 'bv-node' + (state.selectedUid === node.uid ? ' bv-node--selected' : ''),
      dataset: { uid: node.uid },
      style: { paddingLeft: 6 + depth * 12 + 'px' },
      onclick: function (e) { e.stopPropagation(); api.select(node.uid) },
      onmouseenter: function () { api.hover(node.uid) },
      onmouseleave: function () { api.endHover() }
    }, parts)

    wrap.appendChild(row)

    if (hasChildren && expanded) {
      const childBox = el('div', { class: 'bv-children' })
      for (let i = 0; i < node.children.length; i++) {
        childBox.appendChild(renderNode(node.children[i], state, depth + 1))
      }
      wrap.appendChild(childBox)
    }
    return wrap
  }

  function render(state) {
    // 布局切换先于内容渲染处理(早退分支也要执行,否则只有树内容变化时才会同步尺寸)
    syncLayout(state.layout)

    if (lastRevision === state.treeRevision) return
    lastRevision = state.treeRevision

    clear(treeBox)
    const snapshot = state.snapshot

    if (!snapshot) {
      treeBox.appendChild(el('div', {
        class: 'bv-empty',
        text: (state.pageReloading || !state.contentAlive)
          ? '页面正在重新加载,等待页面…'
          : '未检测到 Bindview 应用'
      }))
      return
    }
    if (!snapshot.apps || !snapshot.apps.length) {
      treeBox.appendChild(el('div', {
        class: 'bv-empty',
        text: state.contentAlive
          ? '暂无可显示的组件(应用可能尚未初始化)'
          : '页面正在重新加载,等待页面…'
      }))
      return
    }

    snapshot.apps.forEach(function (app) {
      treeBox.appendChild(el('div', { class: 'bv-app-title' }, [
        el('span', { class: 'bv-app-name', text: app.name }),
        app.version ? el('span', { class: 'bv-app-version', text: 'v' + app.version }) : null
      ]))

      let root = app.root
      if (state.search) {
        root = filterTree(root, state.search)
        if (!root) return
      }
      treeBox.appendChild(renderNode(root, state, 0))
    })
  }

  /**
   * 就地更新某个节点的更新统计
   *
   * 组件「更新」时后端只推增量(component:updated)、不再重发全量快照,
   * 因此这里只更新对应节点的徽标 DOM,而不是重建整棵树:
   * 既避免高频更新时的抖动与滚动位置丢失,又保证与检查器数值一致。
   *
   * @param {Object} node 已同步过统计字段的树节点
   */
  function updateStats(node) {
    if (!node || !node.uid) return
    const row = document.querySelector(uidSelector(node.uid))
    if (!row) return

    const text = badgeText(node)
    let badge = row.querySelector('.bv-node-meta')

    if (!text) {
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge)
      return
    }
    if (!badge) {
      // 与 renderNode 中的顺序保持一致:name → route → badge → 子节点数
      badge = el('span', { class: 'bv-node-meta' })
      const countEl = row.querySelector('.bv-node-count')
      if (countEl) row.insertBefore(badge, countEl)
      else row.appendChild(badge)
    }
    badge.textContent = text
    badge.title = badgeTitle(node)
  }

  return { render: render, updateStats: updateStats }
}
