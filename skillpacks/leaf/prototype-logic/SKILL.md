---
name: prototype-logic
description: 构建一个可双击运行的单文件逻辑原型，用领域语言展示状态、自由操作和可重复 walkthrough。仅供 prototype worker 使用。
compatibility: Pi Agent with repository write and local validation tools.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: worker
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/prototype/LOGIC.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Prototype Logic

只在父任务明确选择 `logic` branch 时应用。原型回答一个状态模型、业务逻辑或数据形状问题，不是生产实现。

- 生成一个自包含 HTML/CSS/JS 文件，无 framework、bundler、server 或新依赖，双击即可运行。
- 页面顶部用一段可见文字写出唯一问题；面向非开发者使用项目领域语言。
- 把被验证逻辑放在独立纯模块式 `<script>` 代码中，可采用 reducer、state machine、纯函数或确有必要的有状态 module；不得引用 DOM、`document` 或按钮 handler。
- 页面薄壳必须展示完整相关状态，并在每次 action 后重渲染、说明刚发生的变化。
- 提供始终可用的 free-play actions，以及 tabbed guided walkthroughs；每个 scenario 从固定初始状态开始，覆盖 happy path、关键 edge case 和非法操作尝试中与问题相关的部分。
- 只使用内存状态。除非问题本身就是 persistence，否则不得连接数据库、网络或本地持久化。
- 不写 tests、不做生产级错误处理、不抽象未来需求。只运行 HTML/JavaScript syntax 或实际打开所需的最小 runnable check。
- HTML shell 永不进入生产；只有用户验证后的逻辑决定才可在后续 `implement` 中重写为生产代码。

输出必须准确列出 artifact、打开方式、walkthrough review targets、实际命令和 cleanup/capture 计划。无法保持单文件、需要真实 mutation 或问题超出一个原型时返回 `BLOCKED`。
