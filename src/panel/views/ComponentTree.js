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

/** 渲染更新统计徽标(仅统计有更新记录的组件) */
function renderUpdateBadge(node) {
  const count = node.updateCount || 0
  if (!count) return null
  const last = typeof node.lastDuration === 'number' ? node.lastDuration : 0
  const total = typeof node.totalDuration === 'number' ? node.totalDuration : 0
  const avg = count ? total / count : 0
  const round = function (n) { return Math.round(n * 100) / 100 }
  return el('span', {
    class: 'bv-node-meta',
    text: '×' + count + ' · ' + round(last) + 'ms',
    title: '更新 ' + count + ' 次\n最近渲染 ' + round(last) + ' ms\n平均 ' + round(avg) + ' ms\n累计 ' + round(total) + ' ms'
  })
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

  return { render: render }
}
