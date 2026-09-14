/**
 * Bindview DevTools · 发布前自动化测试
 * ------------------------------------------------------------------
 * 覆盖四类检查(不依赖浏览器):
 *   1. 静态完整性:manifest / HTML 引用的资源是否都存在
 *   2. 语法解析:所有 JS 源文件(插件 + 框架 + 路由)可被模块解析器解析
 *   3. 契约一致性:面板 ↔ 后端的 RPC / 消息 type / 框架事件 是否闭合
 *   4. 纯逻辑单测:从真实源码中提取函数并断言行为
 * ------------------------------------------------------------------
 * 用法:npm test
 *      (等价于 node --experimental-vm-modules test/release-check.mjs;
 *       需在 bindview-devtools/ 目录下执行 —— 脚本内路径基于该目录)
 */
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'

// 统一以 bindview-devtools/ 为基准目录,保证从任意位置运行结果一致
process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))

let pass = 0
const failures = []
const notes = []

function ok(name) { pass++; console.log('  PASS ' + name) }
function fail(name, detail) {
  failures.push(name + (detail ? ' :: ' + detail : ''))
  console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
}
function check(name, cond, detail) { cond ? ok(name) : fail(name, detail) }
function note(text) { notes.push(text); console.log('  NOTE ' + text) }
function section(title) { console.log('\n=== ' + title + ' ===') }

const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => fs.existsSync(p)

/**
 * 提取 `function name(...) {...}` 的完整源码
 * 花括号配对需跳过字符串与注释(函数体内可能存在 '{' / '[' 这类字面量)
 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('未找到函数: ' + name)
  let depth = 0
  let state = null // ' " ` // /*
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    const c = src[j]
    const n = src[j + 1]
    if (state) {
      if (state === '//' && c === '\n') state = null
      else if (state === '/*' && c === '*' && n === '/') { state = null; j++ }
      else if (state !== '//' && state !== '/*' && c === '\\') j++
      else if (state !== '//' && state !== '/*' && c === state) state = null
      continue
    }
    if (c === '/' && n === '/') { state = '//'; j++; continue }
    if (c === '/' && n === '*') { state = '/*'; j++; continue }
    if (c === "'" || c === '"' || c === '`') { state = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('花括号不配对: ' + name)
}

async function loadModule(code, identifier) {
  const mod = new vm.SourceTextModule(code, { identifier })
  await mod.link(() => { throw new Error('不应有依赖') })
  await mod.evaluate()
  return mod.namespace
}

function walk(dir) {
  const out = []
  if (!exists(dir)) return out
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(full))
    else out.push(full.replace(/\\/g, '/'))
  }
  return out
}

/* ================================================================== */
section('1. 静态完整性')

const manifest = JSON.parse(read('manifest.json'))
check('manifest_version = 3', manifest.manifest_version === 3, manifest.manifest_version)
check('name 存在', typeof manifest.name === 'string' && manifest.name.length > 0)
check('version 为语义化版本', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version)
check('minimum_chrome_version 存在', !!manifest.minimum_chrome_version)
check('权限含 storage', (manifest.permissions || []).includes('storage'))
check('权限含 scripting(工具栏兜底探测需要)', (manifest.permissions || []).includes('scripting'))
check('host_permissions 声明', Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0)
check('devtools_page 已声明', !!manifest.devtools_page)
check('background.service_worker 已声明', !!(manifest.background && manifest.background.service_worker))
check('action.default_popup 已声明', !!(manifest.action && manifest.action.default_popup))
check('content_scripts 含 MAIN world', (manifest.content_scripts || []).some((cs) => cs.world === 'MAIN'))
check('content_scripts 含 ISOLATED world', (manifest.content_scripts || []).some((cs) => cs.world === 'ISOLATED'))

// 发布元数据
const pkg = JSON.parse(read('package.json'))
check('package.json 版本与 manifest 一致', pkg.version === manifest.version, pkg.version + ' vs ' + manifest.version)
check('LICENSE 存在', exists('LICENSE'))
check('README.md 存在', exists('README.md'))
check('图标源文件存在(用于再生成)', exists('assets/bindview-devtools.png'))
check('icon256 存在', exists('assets/icons/icon256.png'))
check(
  '资产目录无遗漏图标(与 README 描述一致)',
  ['icon16', 'icon32', 'icon48', 'icon128', 'icon256'].every((n) => exists('assets/icons/' + n + '.png'))
)

// 依赖最低版本声明(README 与设置页需保持一致,防止后续漂移)
const readmeText = read('README.md')
const settingsText = read('src/panel/views/Settings.js')
check('README 声明 bindview ≥ 3.2.0', readmeText.indexOf('3.2.0') > -1)
check('README 声明 bindview-router ≥ 1.2.0', readmeText.indexOf('1.2.0') > -1)
check('README 声明 Chromium 内核要求', readmeText.indexOf('111') > -1)
check('设置页声明最低版本要求', settingsText.indexOf('3.2.0') > -1 && settingsText.indexOf('1.2.0') > -1)

const manifestRefs = []
manifestRefs.push(manifest.devtools_page, manifest.background.service_worker, manifest.action.default_popup)
Object.values(manifest.icons || {}).forEach((v) => manifestRefs.push(v))
Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((v) => manifestRefs.push(v))
  ; (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach((j) => manifestRefs.push(j)))
for (const ref of manifestRefs.filter(Boolean)) {
  check('manifest 引用存在: ' + ref, exists(ref))
}

for (const html of ['src/panel/index.html', 'src/devtools/devtools.html', 'src/popup/popup.html']) {
  const src = read(html)
  const refs = [...src.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|#|data:)/.test(u))
  check(html + ' 至少引用 1 个资源', refs.length > 0)
  for (const ref of refs) {
    const target = path.join(path.dirname(html), ref).replace(/\\/g, '/')
    check(html + ' → ' + ref, exists(target))
  }
}

/* ================================================================== */
section('2. 语法解析(所有 JS 源文件)')

const jsFiles = [
  ...walk('src'),
  ...walk('../bindview@3/src'),
  ...walk('../bindview-router/src')
].filter((f) => f.endsWith('.js'))

let syntaxBad = 0
for (const file of jsFiles) {
  try {
    new vm.SourceTextModule(read(file), { identifier: file })
  } catch (e) {
    syntaxBad++
    fail('语法: ' + file, e.message)
  }
}
check('全部 JS 文件语法通过(共 ' + jsFiles.length + ' 个)', syntaxBad === 0, syntaxBad + ' 个失败')

/* ================================================================== */
section('3. 契约一致性')

const panelIndex = read('src/panel/index.js')
const backend = read('src/backend/index.js')
const rpcLib = read('src/panel/lib/rpc.js')
const bridgeLib = read('src/panel/lib/bridge.js')
const background = read('src/background.js')

// 3.1 面板调用的 RPC method ⊆ 后端 rpcHandlers
const panelMethods = new Set([...panelIndex.matchAll(/rpc\.call\(\s*'([^']+)'/g)].map((m) => m[1]))
const handlerBlock = backend.slice(
  backend.indexOf('var rpcHandlers = {'),
  backend.indexOf('function handleRpc(')
)
const backendMethods = new Set([...handlerBlock.matchAll(/^\s{4}(\w+):\s*function/gm)].map((m) => m[1]))
check('面板使用了 RPC', panelMethods.size > 0)
for (const m of panelMethods) {
  check('RPC 已实现: ' + m, backendMethods.has(m))
}
for (const m of backendMethods) {
  if (!panelMethods.has(m)) note('后端 RPC 未被面板使用: ' + m + '(可能供外部/兼容使用)')
}

// 3.2 面板 → 后端的消息 type
const panelSends = new Set([...panelIndex.matchAll(/bridge\.send\(\s*\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]))
const backendCases = new Set([...backend.matchAll(/case\s+'([^']+)':/g)].map((m) => m[1]))
// Port 通道消息由 background 的 onConnect 处理,不经页面后端
const portOnlyTypes = new Set(['panel:init'])
// 注意:background 同时使用 `msg.type === 'x'` 与 `msg.type !== 'x'` 两种写法
const bgHandled = new Set([...background.matchAll(/msg\.type\s*[!=]==?\s*'([^']+)'/g)].map((m) => m[1]))
const popupJs = read('src/popup/popup.js')
check('popup 发送 popup:getState', popupJs.indexOf("'popup:getState'") > -1)
for (const t of panelSends) {
  if (portOnlyTypes.has(t)) {
    check('Port 消息由 background 处理: ' + t, true)
  } else {
    check('后端可处理面板消息: ' + t, backendCases.has(t))
  }
}
check('background 处理 Port 初始化', read('src/background.js').indexOf("msg.type === 'panel:init'") > -1)
check('background 处理 popup 查询', bgHandled.has('popup:getState'))

// 3.3 后端 → 面板的推送 type
const backendPosts = new Set([...backend.matchAll(/post\(\s*'([^']+)'/g)].map((m) => m[1]))
const panelCases = new Set([...panelIndex.matchAll(/case\s+'([^']+)':/g)].map((m) => m[1]))
const rpcCases = new Set([...rpcLib.matchAll(/message\.type\s*!==\s*'([^']+)'/g)].map((m) => m[1]))
const bgOnly = new Set(['bindview:status', 'action:probe:result', 'rpc:response'])
for (const t of backendPosts) {
  const handled = panelCases.has(t) || rpcCases.has(t) || bgOnly.has(t)
  check('面板/后台可处理后端推送: ' + t, handled)
}

// 3.4 框架上报的事件 ⊆ 后端订阅
const fwDevtools = read('../bindview@3/src/tools/devtools.js')
const routerDevtools = read('../bindview-router/src/tools/devtools.js')
const emitted = new Set([
  ...[...fwDevtools.matchAll(/emitDevtools\(\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...routerDevtools.matchAll(/emitRouterDevtools\(\s*'([^']+)'/g)].map((m) => m[1])
])
const subscribed = new Set([...backend.matchAll(/hook\.on\(\s*'([^']+)'/g)].map((m) => m[1]))
check('框架有事件上报', emitted.size > 0)
for (const e of emitted) {
  check('后端已订阅框架事件: ' + e, subscribed.has(e))
}

// 3.5 后台 ↔ 内容脚本的消息 type
const contentSends = new Set([...read('src/contentScript.js').matchAll(/sendToExtension\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]))
const bgHandles = new Set([...background.matchAll(/msg\.type ===\s*'([^']+)'/g)].map((m) => m[1]))
for (const t of contentSends) {
  check('后台可处理内容脚本消息: ' + t, bgHandles.has(t))
}

// 3.6 CSS 类名:JS 中使用但 CSS 未定义(仅提示,便于人工判断)
const panelJs = [panelIndex, ...walk('src/panel/views').map(read), ...walk('src/panel/lib').map(read)].join('\n')
const css = read('src/panel/index.css')
const cssClasses = new Set([...css.matchAll(/\.(bv-[a-z0-9-]+)/g)].map((m) => m[1]))
const jsClasses = new Set([...panelJs.matchAll(/'(bv-[a-z0-9-]+)'/g)].map((m) => m[1]))
const cssMissing = [...jsClasses].filter((c) => !cssClasses.has(c))
if (cssMissing.length) note('JS 使用但 CSS 未定义(多为无样式需求的容器): ' + cssMissing.join(', '))
check('CSS 类名检查完成', true)

/* ================================================================== */
section('4. 纯逻辑单测')

// 4.1 Inspector.descriptorFromRaw —— 宽松值解析
const inspectorSrc = read('src/panel/views/Inspector.js')
const nsInspector = await loadModule(
  [extractFn(inspectorSrc, 'descriptorFromRaw')].join('\n') + '\nexport { descriptorFromRaw }\n',
  'Inspector'
)
const dfr = nsInspector.descriptorFromRaw
check('descriptor: JSON 数字', JSON.stringify(dfr('1')) === JSON.stringify({ descriptor: { kind: 'json', value: '1' }, type: 'JSON', error: null }))
check('descriptor: 裸文本按字符串', dfr('hello').descriptor.kind === 'string' && dfr('hello').descriptor.value === 'hello')
check('descriptor: 引号字符串走 JSON', dfr('"a"').descriptor.kind === 'json')
check('descriptor: 非法对象字面量报错', !!dfr('{a:1}').error)
check('descriptor: 非法数组字面量报错', !!dfr('[1,').error)
check('descriptor: 空输入返回 null', dfr('   ') === null)
check('descriptor: true/false 走 JSON', dfr('true').descriptor.kind === 'json' && dfr('false').descriptor.kind === 'json')

// 4.2 ComponentTree.filterTree / 徽标口径
const treeSrc = read('src/panel/views/ComponentTree.js')
const nsTree = await loadModule(
  [extractFn(treeSrc, 'filterTree'), extractFn(treeSrc, 'round'), extractFn(treeSrc, 'badgeText'), extractFn(treeSrc, 'badgeTitle')].join('\n') +
  '\nexport { filterTree, round, badgeText, badgeTitle }\n',
  'ComponentTree'
)
const sampleTree = {
  uid: 'r', name: 'Root', children: [
    { uid: 'a', name: 'A', children: [{ uid: 'b', name: 'CompB', children: [] }] },
    { uid: 'c', name: 'C', children: [] }
  ]
}
const filtered = nsTree.filterTree(sampleTree, 'compb')
check('filterTree 保留命中与祖先链', !!filtered && filtered.children.length === 1 &&
  filtered.children[0].uid === 'a' && filtered.children[0].children[0].uid === 'b')
check('filterTree 无命中返回 null', nsTree.filterTree(sampleTree, 'zzz') === null)
check('filterTree 不修改原树', sampleTree.children.length === 2)
check('badgeText 无更新时为空', nsTree.badgeText({ updateCount: 0 }) === '')
check('badgeText 文案', nsTree.badgeText({ updateCount: 3, lastDuration: 12.345 }) === '×3 · 12.35ms')

// 徽标与检查器口径:同为 round(两位小数)
const insSrc = read('src/panel/views/Inspector.js')
const roundBlock = extractFn(insSrc, 'round')
const nsRound = await loadModule(roundBlock + '\nexport { round }\n', 'round')
check('徽标与检查器 round 口径一致', nsRound.round(12.345) === nsTree.round(12.345) &&
  nsTree.badgeTitle({ updateCount: 2, lastDuration: 1, totalDuration: 5 }).indexOf('平均 2.5 ms') > -1,
  nsTree.badgeTitle({ updateCount: 2, lastDuration: 1, totalDuration: 5 }))

// 4.3 Router 面板文案
const routerSrc = read('src/panel/views/Router.js')
const nsRouter = await loadModule(
  [extractFn(routerSrc, 'componentName'), extractFn(routerSrc, 'componentText'), extractFn(routerSrc, 'renderedText')].join('\n') +
  '\nexport { componentName, componentText, renderedText }\n',
  'Router'
)
check('componentText 空值 → —', nsRouter.componentText(null) === '—')
check('componentText 路由表条目', nsRouter.componentText({ path: '/A', component: { kind: 'vnode', name: 'A' } }) === '/A · <A>')
check('componentText 推断条目', nsRouter.componentText({ path: '/B', component: { kind: 'component', name: 'B' } }) === '/B · <B>')
check('renderedText 无表 + 无推断时说明原因',
  nsRouter.renderedText({ rendered: null, tables: [] }).indexOf('未注册路由表') > -1,
  nsRouter.renderedText({ rendered: null, tables: [] }))
check('renderedText 有表但未命中时说明原因',
  nsRouter.renderedText({ rendered: null, tables: [{ entries: [] }] }).indexOf('未命中路由表') > -1,
  nsRouter.renderedText({ rendered: null, tables: [{ entries: [] }] }))

// 4.4 后端 parseDescriptor —— 类型解析
const STUBS = `
var MAX_DEPTH = 6, MAX_ENTRIES = 100
function truncate(s, l) { s = String(s); return s.length > (l || 200) ? s.slice(0, l) + '…' : s }
function safeGet(o, k) { try { return o[k] } catch (e) { return undefined } }
function serializeDom() { return { type: 'dom', preview: '<div>' } }
function isPlainObject(v) { return Object.prototype.toString.call(v) === '[object Object]' }
var hook = null
export function __setHook(h) { hook = h }
`
const nsBackend = await loadModule(
  STUBS + '\n' + [
    extractFn(backend, 'parseDescriptor'),
    extractFn(backend, 'toJsonSafe'),
    extractFn(backend, 'childComponentNames'),
    extractFn(backend, 'inferRenderedComponent')
  ].join('\n') + '\nexport { parseDescriptor, toJsonSafe, childComponentNames, inferRenderedComponent }\n',
  'backend-lib'
)
const pd = nsBackend.parseDescriptor
check('descriptor: string', pd({ kind: 'string', value: 'a' }) === 'a')
check('descriptor: number', pd({ kind: 'number', value: '12.5' }) === 12.5)
check('descriptor: 非法数字抛错', (() => { try { pd({ kind: 'number', value: 'abc' }); return false } catch (e) { return true } })())
check('descriptor: boolean', pd({ kind: 'boolean', value: 'true' }) === true && pd({ kind: 'boolean', value: 'false' }) === false)
check('descriptor: bigint', pd({ kind: 'bigint', value: '10' }) === BigInt(10))
check('descriptor: null / undefined', pd({ kind: 'null' }) === null && pd({ kind: 'undefined' }) === undefined)
check('descriptor: json 对象', JSON.stringify(pd({ kind: 'json', value: '{"a":1}' })) === '{"a":1}')
check('descriptor: json 空值抛错', (() => { try { pd({ kind: 'json', value: '  ' }); return false } catch (e) { return true } })())
check('descriptor: json 非法抛错', (() => { try { pd({ kind: 'json', value: '{a:1}' }); return false } catch (e) { return true } })())

// 4.5 后端 toJsonSafe —— 安全序列化
const circular = { n: 1 }; circular.self = circular
const jsonSafe = nsBackend.toJsonSafe({
  nil: null, big: BigInt(3), fn: function named() { },
  list: [1, circular], map: new Map([['k', 'v']]), set: new Set([1]), deep: { a: 1 }
}, [], 0)
let safeJson = ''
let safeThrew = null
try { safeJson = JSON.stringify(jsonSafe) } catch (e) { safeThrew = e }
check('toJsonSafe 不抛错', safeThrew === null, safeThrew && safeThrew.message)
check('toJsonSafe 输出可 JSON.stringify', safeJson.length > 0)
const back = JSON.parse(safeJson)
check('toJsonSafe: null 保留', back.nil === null)
check('toJsonSafe: BigInt → 字符串', back.big === '3')
check('toJsonSafe: 函数占位', back.fn === '[Function named]')
check('toJsonSafe: 循环引用标记', back.list[1].self === '[Circular]')
check('toJsonSafe: Map → 对象', back.map.k === 'v')
check('toJsonSafe: Set → 数组', JSON.stringify(back.set) === '[1]')

// 4.6 路由组件推断(注入假 hook)
const fakeChild = { name: 'B' }
const fakeVm = { _KeyMapComponent: new Map([['k', fakeChild]]) }
nsBackend.__setHook({
  getInstance(uid) { return uid === 'sw1' ? fakeVm : null }
})
check('childComponentNames 取子组件名', JSON.stringify(nsBackend.childComponentNames(fakeVm)) === '["B"]')
check('childComponentNames 容错(空实例)', nsBackend.childComponentNames(null).length === 0)
const inferred = nsBackend.inferRenderedComponent([
  { uid: 'sw1', rank: 1, path: '/B' }
])
check('inferRenderedComponent 推断出组件', !!inferred && inferred.component.name === 'B' && inferred.path === '/B',
  JSON.stringify(inferred))
nsBackend.__setHook({ getInstance() { return { _KeyMapComponent: new Map() } } })
check('inferRenderedComponent 无渲染组件时返回 null(如 404)',
  nsBackend.inferRenderedComponent([{ uid: 'sw1', rank: 1, path: '/x' }]) === null)

/* ================================================================== */
console.log('\n========================================')
console.log('通过 ' + pass + ' 项,失败 ' + failures.length + ' 项')
if (notes.length) console.log('提示 ' + notes.length + ' 条')
if (failures.length) {
  console.log('\n失败明细:')
  failures.forEach((f) => console.log('  - ' + f))
}
console.log('========================================')
process.exit(failures.length ? 1 : 0)
