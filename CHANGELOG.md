# Changelog

## 0.2.4

- 为本地代码读取、评审和实现子代理开放 `fffind` 与 `ffgrep`。
- 为唯一写者 `matt-worker` 开放 `apply_patch`，并将其声明为 mutation tool。
- 在安装说明中列明 FFF 与 Codex minimal tools provider。

## 0.2.3

- 在 workflow lane 缺少合法结构化输出时优先报告子代理的 timeout、provider error、termination、turn budget 等真实失败原因。
- 明确 `git_read` 的 `diff-files` action 也必须提供 `ref`。

## 0.2.2

- 在 `matt-setup` 中内置 canonical Local Markdown Wayfinding 路径、字段和模板，并在写后拒绝不兼容的 `Claim:` 与 decision ticket 路径。
- 从 Pi 提供的 skill location 定位 package registry，区分 registry metadata 与 package resource 暴露。
- 统一 Wayfinder decision ticket 的 `Type:` 短名称与 `matt-*` resolver 名称。

## 0.2.1

- 取消 `pi-subagents` 的版本绑定，由目标项目安装当前可用版本。

## 0.2.0

- 将 tracker、领域上下文、ADR、spec、tickets 与 Wayfinder 文档统一收口到 `.x-matt/`。

## 0.1.0

- 首次发布 Pi-native Matt Pocock 工程工作流。
- 提供 `matt-*` parent skills、受限 agents、结构化 dispatcher，并依赖 project-local `pi-subagents` runtime。
- 支持项目级 Git package 安装，并将 package 校验根与目标代码库根分离。
