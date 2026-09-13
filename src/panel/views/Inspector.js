import { el, clear } from '../lib/dom.js'

function renderLeaf(node, path, section, ins, api) {
  const editable = node.editable && section.editable && section.source
  const valueEl = el('span', {
    class: 'bv-value bv-value--' + node.type + (editable ? ' bv-value--editable' : ''),
    text: node.preview,
    title: editable ? '点击编辑' : ''
  })
  if (editable) {
    valueEl.addEventListener('click', function () { startEdit(valueEl, node, path, section, ins, api) })
  }
  return valueEl
}

function startEdit(valueEl, node, path, section, ins, api) {
  let control
  if (node.type === 'boolean') {
    control = el('select', { class: 'bv-edit bv-edit--select' })
      ;['true', 'false'].forEach(function (v) {
        control.appendChild(el('option', { value: v, text: v, selected: String(node.value) === v }))
      })
  } else {
    control = el('input', {
      class: 'bv-edit',
      type: node.type === 'number' ? 'number' : 'text',
      value: node.type === 'string' ? node.value : String(node.value)
    })
  }

  valueEl.replaceWith(control)
  try {
    control.focus()
    if (control.select && node.type !== 'boolean') control.select()
  } catch (e) { /* ignore */ }

  let settled = false

  function commit() {
    if (settled) return
    settled = true
    const raw = control.value
    let descriptor
    if (node.type === 'number') descriptor = { kind: 'number', value: raw }
    else if (node.type === 'boolean') descriptor = { kind: 'boolean', value: raw }
    else descriptor = { kind: 'string', value: raw }
    api.setState(ins.uid, section.source, path, descriptor)
  }

  function cancel() {
    if (settled) return
    settled = true
    api.refreshInspection()
  }

  control.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  control.addEventListener('blur', commit)
  if (node.type === 'boolean') control.addEventListener('change', commit)
}

function renderValueNode(node, path, section, ins, api, depth) {
  if (node.entries && node.entries.length) {
    // 容器节点(object / array / map / set)可折叠:默认折叠,点击头部展开
    const box = el('div', { class: 'bv-obj bv-obj--collapsed' })

    const arrow = el('span', { class: 'bv-arrow', text: '▸' })
    const head = el('div', {
      class: 'bv-obj-head',
      title: '点击展开 / 折叠(' + node.entries.length + ' 项)'
    }, [
      arrow,
      el('span', { class: 'bv-preview', text: node.preview }),
      node.truncated ? el('span', { class: 'bv-truncated', text: '(已截断)' }) : null
    ])
    head.addEventListener('click', function (e) {
      e.stopPropagation()
      const collapsed = box.classList.toggle('bv-obj--collapsed')
      arrow.textContent = collapsed ? '▸' : '▾'
    })

    const kids = el('div', { class: 'bv-obj-children' })
    node.entries.forEach(function (entry) {
      kids.appendChild(el('div', {
        class: 'bv-entry',
        style: { paddingLeft: depth * 12 + 'px' }
      }, [
        el('span', { class: 'bv-key', text: entry.key }),
        el('span', { class: 'bv-colon', text: ':' }),
        renderValueNode(entry.value, path.concat([entry.key]), section, ins, api, depth + 1)
      ]))
    })

    box.appendChild(head)
    box.appendChild(kids)
    return box
  }
  return renderLeaf(node, path, section, ins, api)
}

/**
 * 键值型只读分区(如「路由」):每个组件都会展示当前路由信息
 */
function renderKvSection(section) {
  const box = el('section', { class: 'bv-section' })

  box.appendChild(el('div', { class: 'bv-section-title' }, [
    el('span', { class: 'bv-section-label', text: section.label }),
    el('span', { class: 'bv-chip bv-chip--readonly', text: '只读' })
  ]))

  const body = el('div', { class: 'bv-section-body bv-router-kv' })
    ; (section.rows || []).forEach(function (row) {
      body.appendChild(el('div', { class: 'bv-kv' }, [
        el('span', { class: 'bv-kv-key', text: row.key }),
        el('span', { class: 'bv-kv-value', text: row.value })
      ]))
    })

  box.appendChild(body)
  return box
}

function renderSection(section, ins, api) {
  const box = el('section', { class: 'bv-section' })

  const title = el('div', { class: 'bv-section-title' }, [
    el('span', { class: 'bv-section-label', text: section.label }),
    // props / refs 等不可编辑分区给出明确标记,避免误以为可点击编辑
    section.editable
      ? null
      : el('span', { class: 'bv-chip bv-chip--readonly', text: '只读', title: '该分区不支持修改' }),
    el('span', {
      class: 'bv-section-badge',
      text: section.node ? section.node.preview : '—'
    })
  ])
  box.appendChild(title)

  const body = el('div', { class: 'bv-section-body' })
  if (section.node && section.node.entries && section.node.entries.length) {
    section.node.entries.forEach(function (entry) {
      body.appendChild(el('div', { class: 'bv-entry' }, [
        el('span', { class: 'bv-key', text: entry.key }),
        el('span', { class: 'bv-colon', text: ':' }),
        renderValueNode(entry.value, [entry.key], section, ins, api, 0)
      ]))
    })
  } else {
    body.appendChild(el('div', {
      class: 'bv-entry bv-entry--empty',
      text: section.node ? section.node.preview : '—'
    }))
  }
  box.appendChild(body)
  return box
}

function renderHeader(ins, api) {
  const duration = typeof ins.lastDuration === 'number' ? ins.lastDuration.toFixed(2) : '0.00'

  // 页面高亮统一由右上角「高亮」开关(鼠标悬停)控制,这里只保留定位
  const actions = el('div', { class: 'bv-inspector-actions' }, [
    el('button', { class: 'bv-btn bv-btn--sm', onclick: function () { api.scrollTo(ins.uid) } }, '定位到页面')
  ])

  return el('div', { class: 'bv-inspector-header' }, [
    el('div', { class: 'bv-inspector-title' }, [
      el('span', { class: 'bv-inspector-name', text: '<' + ins.name + '>' }),
      ins.isComponent
        ? el('span', { class: 'bv-tag', text: '组件' })
        : el('span', { class: 'bv-tag bv-tag--root', text: '根实例' })
    ]),
    el('div', { class: 'bv-inspector-meta' }, [
      el('span', { class: 'bv-meta-item', text: '更新 ' + (ins.updateCount || 0) + ' 次' }),
      el('span', { class: 'bv-meta-item', text: '最近渲染 ' + duration + ' ms' }),
      el('span', { class: 'bv-meta-item', text: 'DOM ' + (ins.el ? ins.el.preview : '—') }),
      el('span', { class: 'bv-meta-item', text: '子组件 ' + (ins.childrenCount || 0) })
    ]),
    actions
  ])
}

/**
 * methods 专区:方法名 / 形参个数 / async,可展开源码、可调用
 */
function renderMethodsSection(ins, api) {
  const list = ins.methods || []
  const box = el('section', { class: 'bv-section' })

  box.appendChild(el('div', { class: 'bv-section-title' }, [
    el('span', { class: 'bv-section-label', text: 'methods' }),
    el('span', { class: 'bv-section-badge', text: String(list.length) })
  ]))

  const body = el('div', { class: 'bv-section-body bv-methods' })
  if (!list.length) {
    body.appendChild(el('div', { class: 'bv-entry bv-entry--empty', text: '该组件未定义 methods' }))
  }

  list.forEach(function (method) {
    const sourceBox = el('pre', { class: 'bv-code bv-method-source' })
    sourceBox.textContent = method.source || '(源码不可用)'
    sourceBox.style.display = 'none'

    body.appendChild(el('div', { class: 'bv-method' }, [
      el('div', { class: 'bv-method-row' }, [
        el('span', { class: 'bv-method-name', text: 'ƒ ' + method.name + '()' }),
        el('span', {
          class: 'bv-method-meta',
          text: method.arity > 0 ? method.arity + ' 个形参' : '无参数'
        }),
        method.async ? el('span', { class: 'bv-chip bv-chip--warn', text: 'async' }) : null,
        el('span', { class: 'bv-method-actions' }, [
          el('button', {
            class: 'bv-btn bv-btn--sm',
            onclick: function () {
              sourceBox.style.display = sourceBox.style.display === 'none' ? 'block' : 'none'
            }
          }, '源码'),
          el('button', {
            class: 'bv-btn bv-btn--sm bv-btn--primary',
            title: '以空参数调用该方法(等价于在页面中执行 this.' + method.name + '())',
            onclick: function () { api.invokeMethod(ins.uid, method.name) }
          }, '调用')
        ])
      ]),
      sourceBox
    ]))
  })

  box.appendChild(body)
  return box
}

function renderFunctionList(title, items, api) {
  const box = el('section', { class: 'bv-section' })
  box.appendChild(el('div', { class: 'bv-section-title' }, [
    el('span', { class: 'bv-section-label', text: title }),
    el('span', { class: 'bv-section-badge', text: String(items.length) })
  ]))
  const body = el('div', { class: 'bv-section-body bv-section-body--chips' })
  items.forEach(function (item) {
    body.appendChild(el('span', { class: 'bv-chip', title: item.preview || item.name, text: item.name }))
  })
  box.appendChild(body)
  return box
}

export function createInspector(container, api) {
  const pane = el('div', { class: 'bv-inspector-pane' })
  container.appendChild(pane)

  let lastKey = null

  function render(state) {
    const ins = state.inspection
    const key = JSON.stringify({
      uid: state.selectedUid,
      hasIns: !!ins,
      rev: state.inspectionRevision || 0
    })
    if (key === lastKey) return
    lastKey = key

    clear(pane)

    if (state.inspectionLoading) {
      pane.appendChild(el('div', { class: 'bv-empty', text: '正在读取组件状态…' }))
      return
    }
    if (!ins) {
      pane.appendChild(el('div', { class: 'bv-empty', text: '选择左侧组件查看其 props / data / refs' }))
      return
    }
    if (ins.missing) {
      pane.appendChild(el('div', { class: 'bv-empty', text: '组件已销毁' }))
      return
    }

    pane.appendChild(renderHeader(ins, api))
    if (state.error) pane.appendChild(el('div', { class: 'bv-alert', text: state.error }))

    const sections = el('div', { class: 'bv-sections' })
    ins.sections.forEach(function (section) {
      // rows 形态为只读键值分区(「路由」),其余为可编辑的状态分区
      sections.appendChild(section.rows ? renderKvSection(section) : renderSection(section, ins, api))
    })
    pane.appendChild(sections)

    // methods 始终渲染,便于确认组件是否定义了方法
    pane.appendChild(renderMethodsSection(ins, api))

    if (ins.life && ins.life.length) {
      pane.appendChild(renderFunctionList('生命周期', ins.life.map(function (name) {
        return { name: name, preview: 'life.' + name }
      }), api))
    }
  }

  return { render: render }
}
