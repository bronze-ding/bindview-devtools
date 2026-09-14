import { el } from '../lib/dom.js'

export function createSettingsView(container, api) {
  const highlightBtn = el('button', {
    class: 'bv-btn',
    onclick: function () { api.toggleHighlight() }
  }, '切换高亮')

  const versionEl = el('span', { text: '检测中…' })

  // 主题 / 布局 选择组
  const themeButtons = {}
  const themeGroup = el('div', { class: 'bv-choice-group' }, [
    { value: 'dark', label: '黑夜' },
    { value: 'light', label: '白天' },
    { value: 'auto', label: '跟随系统' }
  ].map(function (item) {
    const btn = el('button', {
      class: 'bv-btn bv-btn--sm',
      text: item.label,
      onclick: function () { api.setTheme(item.value) }
    })
    themeButtons[item.value] = btn
    return btn
  }))

  const layoutButtons = {}
  const layoutGroup = el('div', { class: 'bv-choice-group' }, [
    { value: 'horizontal', label: '左右' },
    { value: 'vertical', label: '上下' }
  ].map(function (item) {
    const btn = el('button', {
      class: 'bv-btn bv-btn--sm',
      text: item.label,
      onclick: function () { api.setLayout(item.value) }
    })
    layoutButtons[item.value] = btn
    return btn
  }))

  const pane = el('div', { class: 'bv-view-body bv-settings' }, [
    el('h2', { text: 'Bindview DevTools' }),
    el('div', { class: 'bv-settings-row' }, [
      el('span', { class: 'bv-settings-label', text: '主题' }),
      themeGroup
    ]),
    el('div', { class: 'bv-settings-row' }, [
      el('span', { class: 'bv-settings-label', text: '面板布局' }),
      layoutGroup
    ]),
    el('p', { class: 'bv-muted' }, [
      el('span', { text: '扩展版本 1.0.0 · ' }),
      versionEl
    ]),
    el('p', { class: 'bv-muted', text: '用于调试基于 bindview.js 构建的应用:查看组件树、检查并实时编辑组件状态、观察更新事件时间线。' }),

    el('h3', { text: '使用步骤' }),
    el('ol', {}, [
      el('li', { html: '在 <b>bindview</b> 框架侧接通 devtools 钩子(见 <code>bindview@3/src/tools/devtools.js</code>)。' }),
      el('li', { text: '打开目标页面后,在本面板查看组件树。未检测到组件时点击右上角「刷新」。' }),
      el('li', { text: '点击组件节点查看 props / data / refs;点击可编辑的值即可就地修改并触发响应式更新。' }),
      el('li', { text: '对象 / 数组可点「JSON」或分区标题的「编辑 JSON」整体改写;每行右侧「×」可删除属性,data 分区底部可新增属性。' }),
      el('li', { text: '点「控制台选中」可把该组件实例暴露为页面控制台的 $vm,便于手动调试。' }),
      el('li', { text: '鼠标悬停组件节点时,页面中会高亮对应的 DOM(可在右上角开关)。' })
    ]),

    el('h3', { text: '功能' }),
    el('ul', {}, [
      el('li', { text: '组件树:展示应用根实例与所有子组件层级;支持搜索、全展开 / 全折叠。' }),
      el('li', { text: '节点统计:显示组件的更新次数与最近渲染耗时(悬停查看平均 / 累计耗时)。' }),
      el('li', { text: '状态检查:序列化响应式 data、props、refs 与 methods。' }),
      el('li', { text: '状态编辑:就地编辑基础类型、以 JSON 编辑对象 / 数组、删除属性、新增属性,直接写回 bindview 的 Proxy。' }),
      el('li', { text: '方法调试:查看方法源码、以空参数调用方法并展示返回值与耗时。' }),
      el('li', { text: '事件时间线:记录组件创建、更新(含渲染耗时)、销毁、状态修改与路由跳转;支持暂停记录与关键字过滤。' }),
      el('li', { text: '路由面板:展示路由状态、各级 Switch 命中、路由表与导航历史,并支持编程式导航。' })
    ]),

    el('h3', { text: '常见问题' }),
    el('ul', {}, [
      el('li', { text: '面板显示「等待页面」:页面需为 http/https 协议,且 bindview 应用已初始化。' }),
      el('li', { text: '组件列表为空:确认已按步骤一接通 devtools 钩子,或点击「刷新」。' })
    ]),

    el('div', { class: 'bv-settings-actions' }, highlightBtn)
  ])
  container.appendChild(pane)

  function render(state) {
    // 动态文案每次都更新(高亮开关状态 / 检测到的 bindview 版本)
    highlightBtn.textContent = state.highlightEnabled ? '高亮:开' : '高亮:关'

    // 主题 / 布局 选中态
    for (const value in themeButtons) {
      themeButtons[value].classList.toggle('bv-btn--active', state.theme === value)
    }
    for (const value in layoutButtons) {
      layoutButtons[value].classList.toggle('bv-btn--active', state.layout === value)
    }

    const snapshot = state.snapshot
    let version = null
    if (snapshot && snapshot.apps) {
      for (let i = 0; i < snapshot.apps.length; i++) {
        if (snapshot.apps[i].version) { version = snapshot.apps[i].version; break }
      }
    }
    versionEl.textContent = version ? '当前应用 bindview v' + version : '未检测到 bindview 应用'
  }

  return { render: render }
}
