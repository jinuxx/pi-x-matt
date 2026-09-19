# Attribution

本项目由 `jinuxx` 以 MIT License 发布。Pi-native 方法论移植参考了 Matt Pocock 的 `mattpocock/skills`，上游版本记录在 `vendor/UPSTREAM_SHA`。

上游项目使用 MIT License，许可证原文保留在 `vendor/mattpocock-skills/LICENSE`。移植后的技能面向 Pi Agent 与 pi-subagents，不保留其他 agent harness 的运行时兼容层。

发布包为跨 Pi package module root 使用公共 workflow-resource 注册 API，bundle `pi-subagents@0.69.0` 及其运行时依赖；pi-subagents 由 Nico Bailon 以 MIT License 发布，其许可证随 bundled dependency 保留。该 library copy 不替代目标项目加载的 pi-subagents extension runtime。
