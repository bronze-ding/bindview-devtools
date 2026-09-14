import { el, clear } from '../lib/dom.js'

/** 是否支持「就地输入」编辑(容器类型改走 JSON 编辑器) */
function isInlineEditable(node) {
  return node.type === 'string' ||
    node.type === 'number' ||
    node.type === 'boolean' ||
    node.type === 'bigint' ||
    node.type === 'null' ||
    node.type === 'undefined'
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

function pathLabel(section, path) {
  return path.length ? section.label + '.' + path.join('.') : section.label
}

/**
 * 宽松解析用户输入的值
 *  - 合法 JSON 字面量 → 按 JSON 类型写入(`1`、`"a"`、`true`、`{…}`、`[…]`、`null`)
 *  - 以 `{` / `[` 开头但语法错误 → 明确报错(避免被误当成普通字符串)
 *  - 其余裸文本 → 按字符串写入(`hello` → `"hello"`,与页面里写 `this.data.x = "hello"` 等价)
 * @returns {{descriptor:Object, type:String, error:String}|null} 输入为空时返回 null
 */
function descriptorFromRaw(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return null
  try {
    JSON.parse(text)
    return { descriptor: { kind: 'json', value: text }, type: 'JSON', error: null }
  } catch (e) {
    const head = text.charAt(0)
    if (head === '{' || head === '[') {
      return { descriptor: null, type: null, error: 'JSON 语法错误: ' + e.message }
    }
    return { descriptor: { kind: 'string', value: text }, type: '字符串', error: null }
  }
}

/* --------------------------- JSON 编辑器 --------------------------- */

/**
 * 简易模态编辑器(devtools 面板中 prompt() 不可靠,故自建)
 * @param {Object} options { title, subtitle, text, huge, onSave }
 */
function openJsonEditor(options) {
  const overlay = el('div', { class: 'bv-modal-overlay' })
  const errorEl = el('div', { class: 'bv-modal-error', text: '' })
  const textarea = el('textarea', {
    class: 'bv-modal-textarea',
    spellcheck: 'false'
  })
  textarea.value = options.text || ''

  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  function save() {
    const raw = textarea.value.trim()
    if (!raw) {
      errorEl.textContent = 'JSON 不能为空'
      return
    }
    try {
      JSON.parse(raw)
    } catch (e) {
      errorEl.textContent = 'JSON 语法错误: ' + e.message
      return
    }
    close()
    options.onSave(raw)
  }

  overlay.appendChild(el('div', { class: 'bv-modal' }, [
    el('div', { class: 'bv-modal-title' }, [
      el('span', { class: 'bv-modal-name', text: options.title }),
      options.subtitle ? el('span', { class: 'bv-chip', text: options.subtitle }) : null
    ]),
    options.huge
      ? el('div', { class: 'bv-modal-warn', text: '内容较大(超过 200KB),深度 / 条目可能已被截断' })
      : null,
    errorEl,
    textarea,
    el('div', { class: 'bv-modal-actions' }, [
      el('button', { class: 'bv-btn', onclick: close }, '取消'),
      el('button', { class: 'bv-btn bv-btn--primary', onclick: save }, '保存')
    ])
  ]))

  overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
  document.body.appendChild(overlay)
  try { textarea.focus() } catch (e) { /* ignore */ }
}

/** 读取目标值的 JSON 文本并打开编辑器 */
function editJsonAt(path, section, ins, api) {
  api.getRawJson(ins.uid, section.source, path).then(function (res) {
    if (!res || !res.ok) {
      api.toast((res && res.error) || '读取失败')
      return
    }
    openJsonEditor({
      title: pathLabel(section, path),
      subtitle: res.valueType,
      text: res.json,
      huge: res.huge,
      onSave: function (raw) {
        api.setState(ins.uid, section.source, path, { kind: 'json', value: raw })
      }
    })
  }).catch(function (e) {
    api.toast(e.message)
  })
}

/* ---------------------------- 就地编辑 ---------------------------- */

function renderLeaf(node, path, section, ins, api) {
  const editable = section.editable && section.source && isInlineEditable(node)
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
  const isNil = node.type === 'null' || node.type === 'undefined'
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
      // null / undefined 没有可展示的值:留空表示维持原值,输入按宽松规则解析
      value: isNil ? '' : (node.type === 'string' ? node.value : String(node.value)),
      placeholder: isNil ? 'JSON 或纯文本,留空保持 ' + node.type : ''
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
    else if (node.type === 'bigint') descriptor = { kind: 'bigint', value: raw }
    else if (isNil) {
      const parsed = descriptorFromRaw(raw)
      if (parsed && parsed.error) {
        api.toast(parsed.error)
        api.refreshInspection()
        return
      }
      // 输入了值则按其类型写入(裸文本按字符串),留空则维持 null / undefined
      descriptor = parsed ? parsed.descriptor : { kind: node.type }
    } else descriptor = { kind: 'string', value: raw }
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

/* ----------------------------- 值渲染 ----------------------------- */

function renderEntry(entry, path, section, ins, api, depth) {
  const row = el('div', {
    class: 'bv-entry',
    style: { paddingLeft: depth * 12 + 'px' }
  }, [
    el('span', { class: 'bv-key', text: entry.key }),
    el('span', { class: 'bv-colon', text: ':' }),
    renderValueNode(entry.value, path, section, ins, api, depth + 1)
  ])

  // 仅可编辑分区(data)且为对象属性 / 数组下标时提供删除入口
  // (Map / Set 的条目键不是可直接寻址的属性,故不提供)
  const deletable = section.editable && section.source &&
    (entry.kind === 'prop' || entry.kind === 'index')
  if (deletable) {
    row.appendChild(el('span', {
      class: 'bv-entry-del',
      text: '×',
      title: '删除 ' + entry.key,
      onclick: function (e) {
        e.stopPropagation()
        api.deleteState(ins.uid, section.source, path)
      }
    }))
  }
  return row
}

function renderValueNode(node, path, section, ins, api, depth) {
  if (node.entries && node.entries.length) {
    // 容器节点(object / array / map / set)可折叠:默认折叠,点击头部展开
    const box = el('div', { class: 'bv-obj bv-obj--collapsed' })

    const arrow = el('span', { class: 'bv-arrow', text: '▸' })
    const canEditJson = section.editable && section.source &&
      (node.type === 'array' || node.type === 'object')

    const head = el('div', {
      class: 'bv-obj-head',
      title: '点击展开 / 折叠(' + node.entries.length + ' 项)'
    }, [
      arrow,
      el('span', { class: 'bv-preview', text: node.preview }),
      node.truncated ? el('span', { class: 'bv-truncated', text: '(已截断)' }) : null,
      canEditJson
        ? el('button', {
          class: 'bv-obj-json',
          text: 'JSON',
          title: '以 JSON 编辑 ' + pathLabel(section, path),
          onclick: function (e) {
            e.stopPropagation()
            editJsonAt(path, section, ins, api)
          }
        })
        : null
    ])
    head.addEventListener('click', function (e) {
      e.stopPropagation()
      const collapsed = box.classList.toggle('bv-obj--collapsed')
      arrow.textContent = collapsed ? '▸' : '▾'
    })

    const kids = el('div', { class: 'bv-obj-children' })
    node.entries.forEach(function (entry) {
      kids.appendChild(renderEntry(entry, path.concat([entry.key]), section, ins, api, depth))
    })

    box.appendChild(head)
    box.appendChild(kids)
    return box
  }
  return renderLeaf(node, path, section, ins, api)
}

/* ----------------------------- 分区渲染 ----------------------------- */

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

/**
 * data 为 null / 非对象时的说明,并提供「初始化 data」入口
 * bindview 在 config.data 未定义时会把 vm.data 置为 null,此时没有任何响应式容器可供写入
 */
function renderEmptyDataHint(section, ins, api) {
  const nodeType = section.node ? section.node.type : 'null'
  const isNil = nodeType === 'null' || nodeType === 'undefined'
  const hint = el('span', { class: 'bv-add-hint' })

  function init() {
    hint.className = 'bv-add-hint'
    hint.textContent = '初始化中…'
    api.initData(ins.uid).then(function (res) {
      if (res && res.ok) {
        hint.textContent = res.existed ? 'data 已存在' : '已初始化 data,现在可以新增属性'
      } else {
        hint.className = 'bv-add-hint bv-add-hint--error'
        hint.textContent = (res && res.error) || '初始化失败'
      }
    })
  }

  return el('div', { class: 'bv-add-row bv-add-row--disabled' }, [
    el('span', {
      class: 'bv-muted',
      text: isNil
        ? '该组件未定义 data(vm.data === null),无法新增属性'
        : '该组件的 data 不是对象 / 数组,无法新增属性'
    }),
    isNil
      ? el('button', {
        class: 'bv-btn bv-btn--sm',
        title: '调用框架的 vm._DataProxy({}) 初始化一个空的响应式 data,之后即可新增属性',
        onclick: init
      }, '初始化 data')
      : null,
    hint
  ])
}

/** data 分区底部的「新增属性」行 */
function renderAddRow(section, ins, api) {
  // data 为空 / 非对象时无法新增属性,给出说明与初始化入口而非静默失败
  const rootType = section.node ? section.node.type : null
  if (rootType !== 'object' && rootType !== 'array') {
    return renderEmptyDataHint(section, ins, api)
  }

  const keyInput = el('input', {
    class: 'bv-edit bv-edit--key',
    type: 'text',
    placeholder: '属性名'
  })
  const valueInput = el('input', {
    class: 'bv-edit bv-edit--value',
    type: 'text',
    placeholder: '值:JSON 或纯文本,如 1、"a"、true、hello'
  })
  const hint = el('span', { class: 'bv-add-hint', text: '' })

  function setHint(text, isError) {
    hint.textContent = text || ''
    hint.className = 'bv-add-hint' + (isError ? ' bv-add-hint--error' : '')
  }

  // 输入时实时提示解析结果,避免「看起来没反应」
  valueInput.addEventListener('input', function () {
    const raw = valueInput.value.trim()
    if (!raw) { setHint(''); return }
    const parsed = descriptorFromRaw(raw)
    if (parsed && parsed.error) setHint(parsed.error, true)
    else if (parsed) setHint('将以 ' + parsed.type + ' 写入')
  })

  function add() {
    const key = keyInput.value.trim()
    const raw = valueInput.value.trim()
    if (!key) { setHint('请输入属性名', true); return }
    if (!raw) { setHint('请输入值', true); return }

    const parsed = descriptorFromRaw(raw)
    if (!parsed || parsed.error) {
      setHint((parsed && parsed.error) || '请输入值', true)
      return
    }

    setHint('写入中…')
    // 成功后清空输入并提示;失败保留输入并给出具体原因
    api.setState(ins.uid, section.source, [key], parsed.descriptor).then(function (res) {
      if (res && res.ok) {
        keyInput.value = ''
        valueInput.value = ''
        setHint('已新增 ' + key + ' = ' + raw)
        api.toast('已新增 ' + key)
      } else {
        setHint('新增失败:' + ((res && res.error) || '未知原因'), true)
      }
    })
  }

  keyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); add() }
  })
  valueInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); add() }
  })

  return el('div', { class: 'bv-add-row' }, [
    keyInput,
    el('span', { class: 'bv-colon', text: ':' }),
    valueInput,
    el('button', {
      class: 'bv-btn bv-btn--sm bv-btn--primary',
      title: '新增属性并写入 bindview 的响应式 data',
      onclick: add
    }, '新增'),
    hint
  ])
}

function renderSection(section, ins, api) {
  const box = el('section', { class: 'bv-section' })
  const isEditable = !!(section.editable && section.source)
  const hasEntries = !!(section.node && section.node.entries && section.node.entries.length)

  const title = el('div', { class: 'bv-section-title' }, [
    el('span', { class: 'bv-section-label', text: section.label }),
    // props / refs 等不可编辑分区给出明确标记,避免误以为可点击编辑
    isEditable
      ? null
      : el('span', { class: 'bv-chip bv-chip--readonly', text: '只读', title: '该分区不支持修改' }),
    el('span', {
      class: 'bv-section-badge',
      text: section.node ? section.node.preview : '—'
    }),
    isEditable && hasEntries
      ? el('button', {
        class: 'bv-btn bv-btn--sm bv-section-action',
        text: '编辑 JSON',
        title: '以 JSON 编辑整个 ' + section.label,
        onclick: function () { editJsonAt([], section, ins, api) }
      })
      : null
  ])
  box.appendChild(title)

  const body = el('div', { class: 'bv-section-body' })
  if (hasEntries) {
    section.node.entries.forEach(function (entry) {
      body.appendChild(renderEntry(entry, [entry.key], section, ins, api, 0))
    })
  } else {
    body.appendChild(el('div', {
      class: 'bv-entry bv-entry--empty',
      text: section.node ? section.node.preview : '—'
    }))
  }

  // 仅 data 分区支持新增属性
  if (section.id === 'data' && isEditable) {
    body.appendChild(renderAddRow(section, ins, api))
  }

  box.appendChild(body)
  return box
}

/* ----------------------------- 头部 ----------------------------- */

function renderHeader(ins, api) {
  const duration = typeof ins.lastDuration === 'number' ? ins.lastDuration.toFixed(2) : '0.00'
  const count = ins.updateCount || 0
  const total = typeof ins.totalDuration === 'number' ? ins.totalDuration : 0

  // 页面高亮统一由右上角「高亮」开关(鼠标悬停)控制,这里只保留定位与控制台联动
  const actions = el('div', { class: 'bv-inspector-actions' }, [
    el('button', { class: 'bv-btn bv-btn--sm', onclick: function () { api.scrollTo(ins.uid) } }, '定位到页面'),
    el('button', {
      class: 'bv-btn bv-btn--sm',
      title: '把该组件实例暴露到页面控制台(window.$vm),便于手动调试',
      onclick: function () { api.exposeInConsole() }
    }, '控制台选中')
  ])

  return el('div', { class: 'bv-inspector-header' }, [
    el('div', { class: 'bv-inspector-title' }, [
      el('span', { class: 'bv-inspector-name', text: '<' + ins.name + '>' }),
      ins.isComponent
        ? el('span', { class: 'bv-tag', text: '组件' })
        : el('span', { class: 'bv-tag bv-tag--root', text: '根实例' })
    ]),
    el('div', { class: 'bv-inspector-meta' }, [
      el('span', { class: 'bv-meta-item', text: '更新 ' + count + ' 次' }),
      el('span', { class: 'bv-meta-item', text: '最近渲染 ' + duration + ' ms' }),
      el('span', { class: 'bv-meta-item', text: '平均 ' + round(count ? total / count : 0) + ' ms' }),
      el('span', { class: 'bv-meta-item', text: '累计 ' + round(total) + ' ms' }),
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
