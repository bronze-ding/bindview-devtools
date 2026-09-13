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

export function createComponentTree(container, api) {
  const input = el('input', {
    class: 'bv-search-input',
    type: 'text',
    placeholder: '搜索组件名称'
  })
  const onInput = debounce(function () { api.setSearch(input.value.trim().toLowerCase()) }, 200)
  input.addEventListener('input', onInput)

  const treeBox = el('div', { class: 'bv-tree' })
  const pane = el('aside', { class: 'bv-tree-pane' }, [
    el('div', { class: 'bv-search' }, input),
    treeBox
  ])
  container.appendChild(pane)

  let lastRevision = null

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
