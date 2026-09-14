import { el, clear, formatTime, debounce } from '../lib/dom.js'

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

  const searchInput = el('input', {
    class: 'bv-input bv-input--filter',
    type: 'text',
    placeholder: '过滤组件 / 目标'
  })
  searchInput.addEventListener('input', debounce(function () {
    api.setTimelineFilter(searchInput.value.trim().toLowerCase())
  }, 150))

  const pauseBtn = el('button', {
    class: 'bv-btn bv-btn--sm',
    title: '暂停后新事件会先缓存,继续时一次性并入',
    onclick: function () { api.toggleTimelinePause() }
  }, '暂停')

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
      searchInput,
      pauseBtn,
      el('button', {
        class: 'bv-btn bv-btn--sm',
        onclick: function () { api.clearTimeline() }
      }, '清空')
    ])
  ])

  const listBox = el('div', { class: 'bv-events' })
  const pane = el('section', { class: 'bv-view-body bv-timeline' }, [toolbar, listBox])
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

  /** 先按事件类型过滤,再按关键字匹配组件名 / 目标 / 事件名 */
  function visibleEvents(timeline, keyword) {
    let list = filter === 'all'
      ? timeline
      : timeline.filter(function (item) { return item.event === filter })
    if (!keyword) return list
    return list.filter(function (item) {
      const label = (EVENT_LABELS[item.event] || item.event || '').toLowerCase()
      const target = ((item.path || '') + ' ' + (item.name || '')).toLowerCase()
      return label.indexOf(keyword) > -1 || target.indexOf(keyword) > -1
    })
  }

  function render(state) {
    const keyword = state.timelineFilter || ''
    const paused = !!state.timelinePaused
    const bufferLength = (state.pausedBuffer || []).length

    pauseBtn.textContent = paused
      ? '继续' + (bufferLength ? '(' + bufferLength + ')' : '')
      : '暂停'
    pauseBtn.classList.toggle('bv-btn--active', paused)

    const events = visibleEvents(state.timeline, keyword)
    const key = filter + '|' + keyword + '|' + (paused ? 'p' : 'r') + '|' + events.length +
      '|' + (events.length ? events[events.length - 1].id : 0)
    if (key === lastKey) return
    lastKey = key

    const atBottom = listBox.scrollTop + listBox.clientHeight >= listBox.scrollHeight - 20
    clear(listBox)

    if (paused && bufferLength) {
      listBox.appendChild(el('div', {
        class: 'bv-timeline-paused',
        text: '已暂停记录,暂存 ' + bufferLength + ' 条事件,点击「继续」后并入'
      }))
    }

    if (!events.length) {
      listBox.appendChild(el('div', {
        class: 'bv-empty',
        text: state.timeline.length ? '没有匹配的事件' : '暂无事件记录'
      }))
      return
    }

    events.forEach(function (item) {
      const row = el('div', {
        class: 'bv-event ' + (EVENT_CLASS[item.event] || ''),
        dataset: item.uid ? { uid: item.uid } : {},
        title: item.uid ? '点击查看该组件' : '',
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
