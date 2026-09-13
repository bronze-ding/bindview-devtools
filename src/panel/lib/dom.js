/**
 * 极简 DOM 构建工具(面板不依赖任何框架)
 */

/**
 * 创建元素
 * @param {String} tag
 * @param {Object} [props] class / text / html / style / dataset / onXxx / 其余作为 attribute
 * @param {Array|Node|String} [children]
 */
export function el(tag, props, children) {
  const node = document.createElement(tag)
  if (props) {
    for (const key in props) {
      const value = props[key]
      if (value === null || value === undefined || value === false) continue
      if (key === 'class') {
        node.className = value
      } else if (key === 'text') {
        node.textContent = value
      } else if (key === 'html') {
        node.innerHTML = value
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value)
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const d in value) node.dataset[d] = value[d]
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
      } else {
        node.setAttribute(key, value === true ? '' : String(value))
      }
    }
  }
  append(node, children)
  return node
}

export function append(node, children) {
  if (children === null || children === undefined || children === false) return
  if (Array.isArray(children)) {
    children.forEach(function (child) { append(node, child) })
    return
  }
  if (children instanceof Node) {
    node.appendChild(children)
    return
  }
  node.appendChild(document.createTextNode(String(children)))
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function formatTime(timestamp) {
  const d = new Date(timestamp)
  const pad = function (n, len) { return String(n).padStart(len || 2, '0') }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
}

export function truncate(text, max) {
  text = String(text)
  const limit = max || 120
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

export function debounce(fn, wait) {
  let timer = null
  return function () {
    const args = arguments
    const self = this
    if (timer) clearTimeout(timer)
    timer = setTimeout(function () {
      timer = null
      fn.apply(self, args)
    }, wait || 120)
  }
}
