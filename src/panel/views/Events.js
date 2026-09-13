import { el, clear, formatTime } from '../lib/dom.js'

const EVENT_LABELS = {
  'app:init': '应用初始化',
  'component:added': '组件创建',
  'component:updated': '组件更新',
  'component:removed': '组件销毁',
  'component:state-change': '状态修改',
  'component:method-call': '方法调用',
  'route:init': '路由安装',
  'route:navigate': '路由跳转'
}

const EVENT_CLASS = {
  'app:init': 'bv-event--init',
  'component:added': 'bv-event--added',
  'component:updated': 'bv-event--updated',
  'component:removed': 'bv-event--removed',
  'component:state-change': 'bv-event--state',
  'component:method-call': 'bv-event--method',
  'route:init': 'bv-event--route',
  'route:navigate': 'bv-event--route'
}

export function createEventsView(container, api) {
  let filter = 'all'

  const filterButtons = {}
  const filters = [
    { id: 'all', label: '全部' },
    { id: 'component:updated', label: '更新' },
    { id: 'component:added', label: '创建' },
    { id: 'component:removed', label: '销毁' },
    { id: 'component:state-change', label: '状态' },
    { id: 'component:method-call', label: '方法' },
    { id: 'route:navigate', label: '路由' }
  ]

  const toolbar = el('div', { class: 'bv-toolbar' }, [
    el('div', { class: 'bv-filters' }, filters.map(function (item) {
      const btn = el('button', {
        class: 'bv-btn bv-btn--sm',
        text: item.label,
        onclick: function () { setFilter(item.id) }
      })
      filterButtons[item.id] = btn
      return btn
    })),
    el('div', { class: 'bv-toolbar-right' }, [
      el('button', {
        class: 'bv-btn bv-btn--sm',
        onclick: function () { api.clearTimeline() }
      }, '清空')
    ])
  ])

  const listBox = el('div', { class: 'bv-events' })
  const pane = el('section', { class: 'bv-view-body' }, [toolbar, listBox])
  container.appendChild(pane)

  let lastKey = null

  function setFilter(next) {
    filter = next
    applyFilterButtons()
    lastKey = null
    api.rerender()
  }

  function applyFilterButtons() {
    for (const id in filterButtons) {
      filterButtons[id].classList.toggle('bv-btn--active', id === filter)
    }
  }
  applyFilterButtons()

  function visibleEvents(timeline) {
    if (filter === 'all') return timeline
    return timeline.filter(function (item) { return item.event === filter })
  }

  function render(state) {
    const events = visibleEvents(state.timeline)
    const key = filter + '|' + events.length + '|' + (events.length ? events[events.length - 1].id : 0)
    if (key === lastKey) return
    lastKey = key

    const atBottom = listBox.scrollTop + listBox.clientHeight >= listBox.scrollHeight - 20
    clear(listBox)

    if (!events.length) {
      listBox.appendChild(el('div', { class: 'bv-empty', text: '暂无事件记录' }))
      return
    }

    events.forEach(function (item) {
      const row = el('div', {
        class: 'bv-event ' + (EVENT_CLASS[item.event] || ''),
        dataset: item.uid ? { uid: item.uid } : {},
        onclick: function () {
          if (item.uid) api.select(item.uid)
        }
      }, [
        el('span', { class: 'bv-event-time', text: formatTime(item.timestamp) }),
        el('span', { class: 'bv-event-name', text: EVENT_LABELS[item.event] || item.event }),
        el('span', { class: 'bv-event-target', text: item.path || item.name || '' }),
        typeof item.duration === 'number' && item.duration > 0
          ? el('span', { class: 'bv-event-extra', text: item.duration.toFixed(2) + ' ms' })
          : null
      ])
      listBox.appendChild(row)
    })

    if (atBottom) listBox.scrollTop = listBox.scrollHeight
  }

  return { render: render }
}
