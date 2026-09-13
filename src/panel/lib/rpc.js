/**
 * 极简 RPC:面板 --(Port)--> background --> content --> 页面后端
 * 以自增 id 关联请求与响应,返回 Promise。
 */

const DEFAULT_TIMEOUT = 8000

export function createRpc(bridge) {
  let seq = 0
  const pending = new Map()

  bridge.onMessage(function (message) {
    if (!message || message.type !== 'rpc:response' || !message.data) return
    const entry = pending.get(message.data.id)
    if (!entry) return
    pending.delete(message.data.id)
    clearTimeout(entry.timer)
    if (message.data.error) entry.reject(new Error(message.data.error))
    else entry.resolve(message.data.result)
  })

  function call(method, params, timeout) {
    return new Promise(function (resolve, reject) {
      const id = ++seq
      const limit = timeout || DEFAULT_TIMEOUT
      const timer = setTimeout(function () {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('请求超时: ' + method))
      }, limit)

      pending.set(id, { resolve: resolve, reject: reject, timer: timer })

      const ok = bridge.send({ type: 'rpc', id: id, method: method, params: params || {} })
      if (!ok) {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error('未连接到页面'))
      }
    })
  }

  return { call: call }
}
