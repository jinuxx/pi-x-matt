---
name: prototype-ui
description: 在真实页面上下文中构建 3–5 个结构显著不同、可通过 URL 参数切换的 UI 原型方案。仅供 prototype worker 使用。
compatibility: Pi Agent with repository write and local validation tools.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: matt-worker
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/prototype/UI.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Prototype UI

只在父任务明确选择 `ui` branch 时应用。原型回答一个“应该长什么样/如何交互”的问题，不是生产 UI。

- 默认生成 3 个、最多 5 个结构显著不同的 variants；它们必须改变 layout、information hierarchy 或 primary affordance，不能只换颜色或文案。
- 优先 sub-shape A：在现有 route/page 中保留真实读取路径、params、auth 和数据密度，只切换 rendered subtree。确无自然 host page 时才按现有 routing convention 创建名字显式含 prototype 的 throwaway route。
- 每个 variant 使用清楚名称，并遵循项目现有 component library 与 styling system；不要新增依赖。
- 使用 `?variant=A|B|...` 选择方案；提供共用的底部 floating switcher、左右循环、当前 label 与键盘 `←`/`→`。input、textarea 或 contenteditable 聚焦时不得拦截方向键。
- switcher 必须以项目等价方式在 production build 隐藏；prototype variants 不得接真实写 API、数据库或外部 mutation，需要交互时使用内存/stub。
- 清楚标记所有 prototype 文件/分支。不要把多个 variants 抽成共享 layout，避免消除真正的结构差异。
- 不写 tests、不做生产级错误处理或抽象。只运行使 route 可加载、可切换所需的最小 compile/typecheck/smoke command。
- 用户必须亲自选择或组合方案；worker 只能呈现差异，不能宣布 winner。

输出必须列出每个 variant 的名称、结构差异、可访问 URL、启动命令、实际验证和 cleanup/capture 计划。无法提供真实 host context、变体不足以区分或需要真实 mutation 时返回 `BLOCKED`。
