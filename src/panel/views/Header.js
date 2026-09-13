import { el } from '../lib/dom.js'

const TABS = [
  { id: 'components', label: '组件' },
  { id: 'router', label: '路由' },
  { id: 'timeline', label: '时间线' },
  { id: 'settings', label: '设置' }
]

export function createHeader(container, api) {
  // 顶栏只展示 logo(不可点击)
  const brand = el('div', { class: 'bv-brand' }, [
    el('img', {
      class: 'bv-logo',
      src: '../../assets/icons/icon128.png',
      alt: 'Bindview DevTools'
    })
  ])

  const tabButtons = {}
  const tabNav = el('nav', { class: 'bv-tabs' }, TABS.map(function (tab) {
    const btn = el('button', {
      class: 'bv-tab',
      text: tab.label,
      onclick: function () { api.setTab(tab.id) }
    })
    tabButtons[tab.id] = btn
    return btn
  }))

  const countEl = el('span', { class: 'bv-count', text: '' })
  const refreshBtn = el('button', {
    class: 'bv-btn',
    title: '重新扫描页面中的 Bindview 组件',
    onclick: function () { api.refresh() }
  }, '刷新')
  const highlightBtn = el('button', {
    class: 'bv-btn',
    title: '鼠标悬停组件时在页面高亮',
    onclick: function () { api.toggleHighlight() }
  }, '高亮')
  const statusDot = el('span', { class: 'bv-status-dot' })
  const statusText = el('span', { class: 'bv-status-text', text: '未连接' })
  const statusEl = el('span', { class: 'bv-status' }, [statusDot, statusText])

  const right = el('div', { class: 'bv-header-right' }, [countEl, refreshBtn, highlightBtn, statusEl])
  container.appendChild(el('header', { class: 'bv-header' }, [brand, tabNav, right]))

  return function update(state) {
    TABS.forEach(function (tab) {
      tabButtons[tab.id].classList.toggle('bv-tab--active', state.activeTab === tab.id)
    })

    highlightBtn.classList.toggle('bv-btn--active', state.highlightEnabled)
    highlightBtn.textContent = state.highlightEnabled ? '高亮:开' : '高亮:关'

    const snapshot = state.snapshot
    countEl.textContent = snapshot ? snapshot.count + ' 个组件' : ''

    const connected = state.status === 'connected' && state.contentAlive
    statusDot.classList.toggle('bv-status-dot--on', connected)
    if (state.status !== 'connected') statusText.textContent = '面板未连接'
    else if (!state.contentAlive) statusText.textContent = '等待页面'
    else statusText.textContent = '已连接'
  }
}
