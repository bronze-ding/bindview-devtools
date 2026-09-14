# Bindview DevTools

一款面向 [bindview.js](https://github.com/bronze-ding/bindview) 应用的浏览器调试插件

- 🌳 **组件树** —— 展示应用根实例与全部子组件的层级结构,支持搜索与全展开 / 全折叠
- 🔍 **状态检查** —— 序列化响应式 `data`、`props`、`refs`、`methods` 与生命周期,并展示更新次数与渲染耗时(最近 / 平均 / 累计)
- ✏️ **状态编辑** —— 就地修改基础类型、以 JSON 编辑对象 / 数组、删除与新增属性,直接写回 bindview 的 Proxy 并触发响应式更新
- 🖥️ **控制台联动** —— 把选中组件实例暴露为页面控制台的 `$vm`,便于手动调试
- 🎯 **组件高亮** —— 鼠标悬停组件节点时在页面中高亮对应 DOM(由右上角开关统一控制),另支持「定位到页面」滚动定位
- ⏱️ **事件时间线** —— 记录组件创建 / 更新(含渲染耗时)/ 销毁 / 状态修改 / 路由跳转,支持暂停记录与关键字过滤
- 🧭 **路由面板** —— 展示 bindview-router 的模式、当前 / 上一路由、query、各级 `Switch` 命中路径、路由表,并支持编程式导航
- 🔌 **状态徽标** —— 工具栏图标固定为彩色 logo;检测到 bindview 应用时显示**绿色徽标 + 组件数量**

插件基于 **Chromium Manifest V3**,Chrome / Edge 等 Chromium 内核浏览器通用,无需构建步骤,可「加载已解压的扩展程序」直接使用。

---

## 一、安装

支持 Chrome / Edge / Brave 等 Chromium 内核浏览器,要求内核版本 ≥ **111**。

### Chrome

1. 打开 Chrome,进入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**,选择本目录 `bindview-devtools/`
4. 打开任意使用 bindview 的页面,按 `F12` 打开开发者工具,切换到 **Bindview** 面板

### Microsoft Edge

1. 打开 Edge,进入 `edge://extensions`
2. 左侧开启 **开发人员模式**
3. 点击 **加载解压缩的扩展**,选择本目录 `bindview-devtools/`
4. 打开任意使用 bindview 的页面,按 `F12` 打开开发者工具,切换到 **Bindview** 面板

> Edge 中面板以「Bindview」标签页出现在开发者工具里,行为与 Chrome 完全一致。

### 浏览器兼容性

- 仅使用 Chromium 通用扩展 API(`chrome.devtools`、`chrome.runtime`、`chrome.tabs`、`chrome.storage`)
  与 MV3 标准字段,不依赖 Chrome 专有能力,因此在 Edge 上无需任何改动即可运行;
- `manifest.json` 的 `minimum_chrome_version` 是 Chromium 通用键,Edge 同样遵循,不会导致加载失败;
- 页面侧通信基于标准 `window.postMessage` 与 DOM,与浏览器实现无关;
- MAIN world 内容脚本依赖 `world: "MAIN"`(Chrome 111 / Edge 111 起支持),低于该版本将无法注入 Hook。

---

## 二、整体架构

```
┌─────────────────────────── DevTools 面板(扩展进程) ───────────────────────────┐
│  src/panel/*  —— 组件树 / 状态检查器 / 事件时间线(零依赖原生实现)              │
└───────────────────────────────────▲───────────────────────────────────────────┘
                                    │ Port(bindview-devtools-panel)
┌───────────────────────────────────┴───────────────────────────────────────────┐
│  src/background.js —— Service Worker,按 tabId 路由面板 ↔ 内容脚本的消息        │
└───────────────────────────────────▲───────────────────────────────────────────┘
                                    │ Port(bindview-devtools-content)
┌───────────────────────────────────┴───────────────────────────────────────────┐
│  src/contentScript.js —— ISOLATED world,仅做 window.postMessage 中转           │
└───────────────────────────────────▲───────────────────────────────────────────┘
                                    │ window.postMessage(SOURCE = bindview-devtools)
┌───────────────────────────────────┴───────────────────────────────────────────┐
│  MAIN world(document_start)                                                    │
│   ├─ src/backend/hook.js  —— 全局 Hook:事件总线 + 实例注册表 + 事件缓存回放     │
│   └─ src/backend/index.js —— 后端:组件树 / 状态序列化 / 编辑 / 高亮 / RPC       │
└───────────────────────────────────▲───────────────────────────────────────────┘
                                    │ hook.emit('component:added' | ...)
┌───────────────────────────────────┴───────────────────────────────────────────┐
│  bindview 框架(bindview@3)                                                    │
│   └─ src/tools/devtools.js —— 生命周期通知(未装插件时空操作)                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

为什么需要「框架侧集成」?
与 Vue 的 `__VUE_DEVTOOLS_GLOBAL_HOOK__` 同理:框架在组件创建 / 更新 / 销毁时主动向全局 Hook 派发事件,
插件才能拿到真实组件实例(含响应式 `data`、`props`、DOM 引用)。未安装插件时该调用直接短路,对业务零影响。

同理,`bindview-router` 也会向同一个 Hook 上报路由信息(插件安装 / 路由跳转 / 路由表变更),因此「路由」页签无需业务代码做任何适配,详见第四节。

---

## 三、目录结构

```
bindview-devtools/
├── manifest.json               # MV3 清单(可直接加载为扩展)
├── package.json
├── README.md
├── assets/
│   ├── bindview-devtools.png   # 图标源文件(747×746,用于再生成)
│   └── icons/                  # 扩展图标资源:icon16 / 32 / 48 / 128 / 256.png
└── src/
    ├── backend/
    │   ├── hook.js             # MAIN world:全局 Hook(事件总线 / 实例表 / 缓存回放)
    │   └── index.js            # MAIN world:后端桥接(组件树 / 序列化 / 高亮 / RPC)
    ├── contentScript.js        # ISOLATED world:消息中转
    ├── background.js           # Service Worker:消息路由
    ├── devtools/
    │   ├── devtools.html
    │   └── devtools.js         # 注册 "Bindview" 面板
    └── panel/
        ├── index.html
        ├── index.css           # 深色主题样式
        ├── index.js            # 面板入口:布局 + 事件处理 + API
        ├── lib/
        │   ├── bridge.js       # Port 连接封装(自动重连)
        │   ├── rpc.js          # 请求/响应 RPC(Promise)
        │   ├── store.js        # 极简发布订阅状态容器
        │   └── dom.js          # DOM 构建 / 格式化工具
        ├── popup/
        │   ├── popup.html      # 工具栏弹出面板
        │   ├── popup.css
        │   └── popup.js        # 查询并展示当前标签页的检测结果
        └── views/
            ├── Header.js       # 顶栏:页签 / 刷新 / 高亮开关 / 连接状态
            ├── ComponentTree.js# 组件树(搜索 / 展开 / 悬停高亮)
            ├── Inspector.js    # 状态检查与就地编辑
            ├── Events.js       # 事件时间线
            └── Settings.js     # 使用说明
```

### 图标资源

扩展图标必须为 **PNG 位图**(Chrome / Edge 不支持 SVG 图标),因此 `assets/` 下提供:

| 文件 | 用途 |
| --- | --- |
| `assets/bindview-devtools.png` | 原始 logo 源文件(747×746 RGBA) |
| `assets/icons/icon16.png` | 扩展列表 / 小尺寸展示 |
| `assets/icons/icon32.png` | 扩展列表 / 小尺寸展示 |
| `assets/icons/icon48.png` | DevTools 面板标签页图标 |
| `assets/icons/icon128.png` | 扩展管理页 / 面板顶栏品牌图标(**显示 26px**,用大图保证高分屏清晰) |
| `assets/icons/icon256.png` | 高清屏 / 文档展示备用 |

图标由源文件 [`bindview-devtools.png`](bindview-devtools/assets/bindview-devtools.png) **按不透明像素外接框裁切为正方形**后
等比例缩放生成(预乘 alpha 面积平均,避免透明边缘出现暗色描边),并声明在
[`manifest.json`](bindview-devtools/manifest.json:7) 的 `icons` 与 `action.default_icon` 中 —— 两处均为**彩色 logo**,工具栏图标固定不变。

---

## 四、框架侧集成

为让插件获取到真实组件实例,框架需要向外派发 3 类事件。相关改动如下:

| 文件 | 改动 |
| --- | --- |
| [`bindview@3/src/tools/devtools.js`](../bindview@3/src/tools/devtools.js) | 新增:全局 Hook 探测、事件派发、活跃实例登记、晚连接回放 |
| [`bindview@3/src/core/Init.js`](../bindview@3/src/core/Init.js:84) | 初始化 `$parent` / `$props`,并在结尾派发 `component:added` |
| [`bindview@3/src/core/createComponentExample.js`](../bindview@3/src/core/createComponentExample.js:51) | 子组件创建前注入 `$parent` 与 `$props` |
| [`bindview@3/src/core/Update.js`](../bindview@3/src/core/Update.js:66) | 统计渲染耗时并派发 `component:updated` |
| [`bindview@3/src/core/Remove.js`](../bindview@3/src/core/Remove.js:13) | 派发 `component:removed` 并注销实例 |

框架暴露的调试 API(可从应用侧使用):

```js
import Bindview, { devtools, getDevtoolsHook, isDevtoolsEnabled } from "bindview"

// 插件是否已安装
console.log(isDevtoolsEnabled())
```

`devtools.js` 的关键实现:

```js
export function emitDevtools(event, payload) {
  const hook = getDevtoolsHook()
  if (!hook) return false            // 未安装插件:空操作
  try { hook.emit(event, payload) } catch (e) { /* 绝不影响业务 */ }
  return true
}
```

### 路由插件(bindview-router)集成

若应用使用 `bindview-router`,路由插件会自动向同一 Hook 上报信息,业务代码无需改动:

| 文件 | 改动 |
| --- | --- |
| [`bindview-router/src/tools/devtools.js`](../bindview-router/src/tools/devtools.js) | 新增:路由信息上报、Router 实例与路由表挂载、晚连接回放 |
| [`bindview-router/src/hash/index.js`](../bindview-router/src/hash/index.js:31) · [`history/index.js`](../bindview-router/src/history/index.js:31) | 安装插件时注册 `{ mode, version, router, bus }` |
| [`bindview-router/src/hash/Bus.js`](../bindview-router/src/hash/Bus.js:15) · [`history/Bus.js`](../bindview-router/src/history/Bus.js:15) | `emit()` 中上报 `router:navigate` |
| [`bindview-router/src/tools/createRouterTable.js`](../bindview-router/src/tools/createRouterTable.js:9) | 创建 / 追加 / 删除路由时上报 `router:table` |

上报的事件:

| 事件 | 负载 |
| --- | --- |
| `router:init` | `{ mode, version, oldURL, newURL, query }` |
| `router:navigate` | `{ oldURL, newURL, query, timestamp }` |
| `router:table` | `{ tables: [{ paths, size, entries }] }`(`entries` 含每个 path 对应的组件描述) |

同时 `Router` 实例与路由表会被挂到 Hook 上(`hook.router` / `hook.routeTables`),
调试器据此直接读取当前路由、调用 `$to` / `$back` / `$forward` 进行导航。

---

## 五、使用说明

### 组件树

- 组件名以 `<Name>` 形式展示,便于与普通 DOM 节点区分
- 首次连接自动展开全部节点;点击 `▸/▾` 或节点行可折叠 / 展开
- 搜索框下方提供 **「全展开」** / **「全折叠」** 两个快捷操作
- 顶部搜索框按名称过滤(保留命中节点的祖先链)
- 节点右侧的 **统计徽标**(`×N · Xms`)显示更新次数与最近一次渲染耗时,悬停可查看平均 / 累计耗时;
  该徽标与右侧检查器头部**展示同一份后端 `meta` 数据**,组件更新时会通过增量事件实时同步(不会出现两处数值不一致)
- **悬停**节点 → 页面中高亮对应 DOM(高亮由右上角「高亮」开关统一控制,**默认开启**,关闭后悬停不再高亮)
- **点击**节点 → 仅在右侧显示组件详情,**不再触发页面高亮**;组件更新时节点会闪烁提示
- **路由标注** → 仅路由组件:`Switch` 节点显示该级别命中路径、`Link` 节点显示跳转目标

### 状态检查与编辑

右侧检查器按分区展示:

| 分区 | 说明 | 可编辑 |
| --- | --- | --- |
| `路由` | **仅路由组件**(`Switch` / `Link`)显示:当前 / 上一路由、query、模式及专属字段 | ❌ |
| `props` | 父组件传入的属性(**只读**) | ❌ |
| `data` | 组件的响应式数据(Proxy) | ✅ |
| `refs` | `ref` 收集到的真实 DOM | ❌ |
| `methods` | 方法名 / 形参个数 / 是否 `async`,可展开源码、可调用 | ▶️ 可调用 |
| 生命周期 | `life` 中定义的生命周期名 | ❌ |

> `路由` 分区**只在路由组件上显示**:`Switch` 显示当前 / 上一路由、query、模式,以及
> `路由级别`、`命中路径`、`路由守卫`、`异步组件`;`Link` 显示当前 / 上一路由、query、模式,
> 以及 `跳转目标`、`当前激活`。普通组件不显示该分区。

点击高亮显示的值即可就地编辑:

- 字符串 / 数字 / `BigInt` → 文本框(`Enter` 提交,`Esc` 取消)
- 布尔值 → 下拉选择
- `null` / `undefined` → 文本框,留空表示维持原值,填写则按 **JSON 字面量**解析(`1`、`"a"`、`true`、`{}` …)

提交后直接写回 bindview 的 Proxy(`parent[key] = value`),因此会像页面内修改数据一样触发调度器批量更新,
可在时间线中看到 `状态修改` 与随之而来的 `组件更新`。

#### 结构化编辑(仅 `data` 分区)

| 操作 | 入口 | 说明 |
| --- | --- | --- |
| 以 JSON 编辑某个对象 / 数组 | 该值行首的 **「JSON」** 按钮 | 弹出 JSON 编辑器,保存后整值写回 |
| 以 JSON 编辑整个 `data` | 分区标题右侧的 **「编辑 JSON」** | 逐键增删,响应式仍按字段粒度触发 |
| 删除属性 / 数组元素 | 该行右侧的 **「×」** | 对象走 `delete`,`数组`走 `splice` |
| 新增属性 | 分区底部的「新增属性」行 | 属性名 + 值(JSON 或纯文本) |

**值解析规则(就地编辑与新增属性共用)**:输入边实时提示将按什么类型写入。

| 输入 | 结果 |
| --- | --- |
| `1`、`true`、`"a"`、`{...}`、`[...]`、`null` | 合法 JSON → 按对应 JSON 类型写入 |
| `hello`(裸文本) | 非 JSON → 按**字符串**写入,等价于 `this.data.x = "hello"` |
| `{a:1}`(以 `{` / `[` 开头但语法错误) | 明确提示 JSON 语法错误,不会静默当成字符串 |

> 新增 / 写入的结果会**直接显示在新增行内**(成功提示「已新增 x = 值」、失败给出具体原因并保留输入),
> 同时写入成功与否都会反映到 `data` 列表与时间线上,不存在「点了没反应」的情况。
>
> **组件未定义 `data` 时**(bindview 在 `config.data` 未定义会把 `vm.data` 置为 `null`,面板会显示 `data: null`),
> 新增行会提供「**初始化 data**」按钮:点击后复用框架的 `vm._DataProxy({})` 创建一个**空的响应式 data**,
> 之后即可正常新增属性并触发响应式更新。
>
> JSON 编辑器在读取时会做深度 / 条目截断(`DOM`、函数、循环引用转为可读字符串),
> 超过 200KB 时会给出提示;保存前会做一次 JSON 语法校验,避免写入非法内容。

#### 控制台联动

检查器头部的 **「控制台选中」** 会把当前组件实例挂到页面 `window.$vm`(同时提供 `window.$bv` 别名),
可在开发者工具 Console 中直接以 `$vm` 访问其 `data` / `methods`:

```js
$vm.data.count           // 读取响应式数据
$vm.methods.increment()  // 调用组件方法
```

#### methods 专区

底部 `methods` 分区列出组件定义的全部方法:

- 展示**方法名、形参个数、是否 `async`**
- 点击「源码」展开该方法的函数源码。
  由于 `vm.methods[name]` 是 `bind(vm)` 之后的绑定函数(源码会变成 `[native code]`),
  框架在 [`HandleMethods`](../bindview@3/src/core/HandleMethods.js:15) 中以**非枚举**的 `__bvRaw__` 保留了原始函数引用供调试器读取
- 点击「调用」以**空参数**执行该方法,返回值与耗时通过面板提示展示,并记入时间线(「方法调用」)
- 组件未定义方法时会显示「该组件未定义 methods」,便于确认

### 事件时间线

- 通过顶部筛选按钮查看「全部 / 更新 / 创建 / 销毁 / 状态 / 方法 / 路由」
- 「更新」事件附带本次 `render + diff` 耗时
- 右侧 **过滤框** 按事件名 / 目标 / 组件名做关键字筛选
- **「暂停 / 继续」** 控制记录:暂停期间新事件进入缓冲区(按钮上显示待入条数),继续时一次性并入,**不丢事件**
- 「清空」同时清理时间线与缓冲区(仅清调试器记录)
- 点击事件行可跳转到对应组件(路由事件无关联组件时不响应点击)

### 路由

顶部「路由」页签展示 bindview-router 的运行状态:

| 区块 | 内容 |
| --- | --- |
| 路由状态 | 是否安装、模式(`hash` / `history`)、版本、当前路由、上一路由、query、当前命中组件、页面标题、浏览器地址 |
| 路由层级 | 每个 `Switch` 组件(按 `rank` 排序)当前命中的路径与对应组件,并标注「守卫」「异步:组件名」「类名」「当前命中」;点击可定位到该组件 |
| 路由表 | `CreateRouterTable` 创建的路由表及全部 `path`(含各 path 对应的组件);支持按路径 / 组件名过滤,当前命中的 path 高亮,点击可直接跳转 |
| 导航历史 | 最近 100 条跳转(`oldURL → newURL` 与 query),高亮当前所处位置,并可一键清空(仅清调试器记录,不影响浏览器会话历史) |
| 导航 | 输入路径或完整 URL(如 `/A`、`#/A?id=1`、`http://host/#/A?id=1`,自动解析 query)、可选 query JSON(填写则覆盖地址中的 query);支持「跳转」「后退」「前进」与 `$go(n)` 相对跳转,后退 / 前进按钮会依据历史指针自动禁用 |

> 多个 `Switch` 在挂载时会各自触发一次 `Bus.emit`,后端已按 `newURL + query` 去重,不会产生重复的导航记录。
> 面板触发的跳转由 `router:navigate` 事件统一记录,时间线中不再出现重复条目。

### 设置

顶栏只展示扩展 logo(不可点击);偏好集中在「设置」页:

| 项 | 选项 | 说明 |
| --- | --- | --- |
| 主题 | 黑夜 / 白天 / 跟随系统 | 通过 `<html data-theme>` + CSS 变量整体切换明暗;`跟随系统` 读取 `prefers-color-scheme` 并实时响应 |
| 面板布局 | 左右 / 上下 | 组件视图:左右为「组件树 \| 检查器」并排,上下为「组件树在上、检查器在下」;分隔线可拖拽调整,**两种布局各自记住拖拽后的尺寸**(切换时不会串用,也不会残留锁死宽度) |
| 高亮 | 开 / 关 | 是否在鼠标悬停组件节点时高亮页面 DOM(默认开) |

主题与布局会写入 `chrome.storage.local`(键 `bindview-devtools:prefs`),重开面板后保持不变。
页面同时展示扩展版本、检测到的 bindview 版本、使用步骤与常见问题。

### 工具栏图标

工具栏**图标固定为彩色 logo**,不随页面内容变化;检测结果通过**徽标**体现:

| 场景 | 表现 |
| --- | --- |
| 激活标签页**检测到** bindview 应用 | 图标不变,**绿色徽标**显示组件数量,悬停提示「检测到 N 个组件」 |
| 激活标签页**未检测到** | 图标不变,清空徽标,悬停提示「Bindview DevTools」 |
| 切换到其他标签页 | 按该页缓存的检测结果**立即**更新徽标,再请求重报以校正 |
| 内容脚本(重)上线 | 请求页面重报(自愈 SW 重启 / 扩展重载) |
| 点击图标 | 弹出**信息面板**(见下),同时重新探测一次并刷新徽标 |
| 页面导航 / 卸载 | 该标签页标记为「未检测到」,若为激活页则清空徽标 |
| 其他标签页 / 内部页 | 未激活时不参与显示;成为激活页时按其检测结果展示 |

**工具栏弹出面板(popup)**:点击图标会弹出一个信息面板(`manifest.action.default_popup`),显示

- 扩展版本
- 当前标签页的检测状态与组件数量(弹开时会再探测一次)
- 使用提示(`F12` → Bindview 面板)
- bindview / bindview-router 仓库链接

数据由 popup 通过 `chrome.runtime.sendMessage({ type: 'popup:getState' })` 向后台查询
(后台会用 `tabs.query` 取激活标签页并读取缓存的检测结果)。

**两条探测通道(互为兜底)**:

1. **消息通道** —— 页面后端在推送组件树快照时附带 `bindview:status { count }`;
   内容脚本(重)上线、切换标签页、页面加载完成时,后台主动发送 `bindview:status:request` 要求立即重报,
   从而自愈 SW 重启 / 扩展重载导致的状态丢失;
2. **scripting 兜底** —— 后台通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 直接读取
   `window.__BINDVIEW_DEVTOOLS_GLOBAL_HOOK__.instances.size`,**不依赖页面侧版本**:
   即使页面后端是较旧版本、或消息通道异常,也能得到正确的检测结果。

> 因此扩展声明了 `scripting` 权限(见 [`manifest.json`](bindview-devtools/manifest.json:14));
> **新增权限后必须重载扩展**才会生效。这两条消息**均不会转发给面板**。

---

## 六、消息协议

面板 ↔ 页面之间采用统一信封:

```js
// 页面 → 扩展
{ source: 'bindview-devtools', direction: 'to-extension', payload: { type, data } }
// 扩展 → 页面
{ source: 'bindview-devtools', direction: 'to-page', payload: { type, data } }
```

**页面后端 → 面板(推送)**

| type | 说明 |
| --- | --- |
| `snapshot` | 组件树全量快照 `{ apps, count, timestamp }` |
| `component:updated` | 组件更新 `{ uid, updateCount, lastDuration, totalDuration }`(面板据此就地同步树徽标统计) |
| `state:invalid` | 组件已销毁,面板应清除选中 |
| `timeline:event` / `timeline:list` | 单条 / 批量事件 |
| `highlight:changed` | 高亮开关状态变更 |
| `backend:ready` | 后端已就绪,面板可刷新 |
| `router:info` | 路由信息(状态 / 层级 / 路由表 / 导航历史),路由变更或组件增删时推送 |

**面板 → 页面后端(RPC)**

`{ type: 'rpc', id, method, params }` → `{ type: 'rpc:response', data: { id, result, error } }`

可用的 `method`:`getTree`、`inspect`、`setState`、`deleteState`、`getRawJson`、`initData`、`invokeMethod`、`exposeInstance`、
`highlight`、`hover`、`unhighlight`、`scrollTo`、`setHighlightEnabled`、`getTimeline`、`clearTimeline`、`rescan`、
`getRouterInfo`、`routerNavigate`、`routerAction`、`clearNavigation`(后四者服务于「路由」页签)。

> `setState` 的 `path` 为空数组时表示**整体替换 `data` 根对象**(逐键增删);
> `getRawJson` 返回目标值的 JSON 文本,`exposeInstance` 把实例挂到页面 `window.$vm`。

---

## 七、常见问题

**改了代码后面板不更新 / 数据还是旧的**(最常见)
: 通常是**没有重新加载**导致,扩展与页面需要分别重载:

1. 改了 `bindview-devtools/` 的插件代码 → 到 `chrome://extensions`(Edge 为 `edge://extensions`)点该扩展的**重新加载**,然后**关闭并重新打开开发者工具**。
   面板是扩展页面,不会热更新,不重开 DevTools 仍是旧代码;
2. 改了应用 / `bindview@3` / `bindview-router` 代码 → **刷新目标页面**。
   内容脚本与 MAIN world 的 Hook、页面后端只在页面加载时注入,已打开的页面仍在运行旧代码;
3. 只改面板样式时重开开发者工具即可;但只要动过 `manifest.json`(权限 / 图标 / `action` / `content_scripts`),
   就必须重载扩展,新声明的能力才会生效。

**刷新页面后插件短时间没数据 / 不再更新**
: 页面刷新会重建 MAIN world 的 Hook 与页面后端,而**面板端口一直存活**。插件已做多层自动恢复:

- 内容脚本重新上线时,后台会主动向新页面补发 `panel:connected` 与 `panel:refresh`([`background.js`](bindview-devtools/src/background.js:99))
- 面板收到 `content:connected` 后会重发一次 `panel:init` 完成重新握手([`panel/index.js`](bindview-devtools/src/panel/index.js:336))
- 页面后端只要收到扩展的任何指令,即视为面板在线;且 `component:updated`、时间线、路由信息**不再做在线门控**,
  未连接时由内容脚本与后台自然丢弃

因此通常会自动恢复,无需手动操作;若仍未恢复,点右上角「刷新」即可。

**切换路由后「组件」页签显示「未检测到 Bindview 应用」**
: 该提示只在面板拿不到组件树快照时出现。插件已做以下处理,正常情况下不会再出现:

- 后台不再监听 `chrome.tabs.onUpdated` 的 `loading`:SPA 路由切换 / `pushState` 也可能触发它,会误判为页面重载而清空组件树
- 页面重载期间**保留上一份组件树**(不再清空),仅清除与旧实例绑定的选中态,并提示「页面正在重新加载,等待页面…」
- 内容脚本重新上线后自动重新握手并刷新;若页面刚重载、应用尚未初始化,会自动重试 3 次(间隔 500ms)

**面板显示「等待页面」**
: 页面需为 `http/https` 协议(浏览器内部页 / `chrome://`、`edge://` / 扩展商店页无法注入);确认 bindview 应用已初始化。

**组件列表为空**
: 确认框架侧已完成第四节集成(即 `bindview` 版本包含 `tools/devtools.js`),或点击右上角「刷新」重新扫描。

**首次打开面板时组件不全**
: 后端会对 Hook 在启用前缓存的事件做一次性回放;若扩展安装晚于页面打开,框架会通过
`__BINDVIEW_DEVTOOLS_HOOK_REPLAY__` 补发全量快照。仍不完整时点击「刷新」。

**修改数据后视图未变化**
: 只有写在响应式 `data` 上的字段才会驱动更新。`props` 与 `refs` 属**只读分区**,
面板不提供编辑入口(标题旁标有「只读」);后端也会拒绝任何针对 `props` 的写入请求。

**「路由」页签提示未检测到 bindview-router**
: 应用需通过 `Bindview.use([hash, components])` 或 `Bindview.use([history, components])` 安装路由插件;
确认 `bindview-router` 版本已包含 `src/tools/devtools.js`(即完成第四节的路由集成)。

---

## 八、设计要点

1. **零侵入**:框架侧所有通知都包裹在 Hook 存在性判断内,未安装插件时与未集成几乎没有差异。
2. **异常隔离**:Hook 的 `emit` 与框架的 `emitDevtools` 双向 `try/catch`,调试器故障不会波及业务。
3. **事件缓存与回放**:`hook.js` 在 `enable()` 之前缓存事件,解决内容脚本与应用的时序竞争。
4. **跨进程安全**:真实的 `Proxy` / DOM 节点只在页面 MAIN world 内使用,跨进程一律通过
   `serializeValue` 转换为带类型标签的纯数据(含循环引用、`Map`/`Set`、DOM 预览、深度与条目上限)。
5. **可重连**:面板、内容脚本、Service Worker 三层均实现断线重连。页面刷新时内容脚本会重新上线,
   后台随即向新页面补发握手(`panel:connected` / `panel:refresh`),面板也会重发 `panel:init`,
   因此刷新页面后无需手动操作即可恢复。
6. **实时推送不做在线门控**:`component:updated`、时间线、路由信息始终推送,未连接时由内容脚本与后台自然丢弃,
   避免「握手因时序丢失 → 静默漏推更新」这类难排查的问题。

---

## License

MIT
