# Project Agent Instructions

本仓库是 pi-x-matt 插件源码维护例外：发布所需的 `.pi/`、工程说明和维护契约继续被 Git 跟踪。使用本插件的业务项目则按 `.pi/skills/matt-setup/privacy.md` 将整个 `.x-matt/` 与个人 `.pi/` 仅保存在本机，不把源码仓库例外推广到目标项目。

## Agent skills

### Issue tracker

Issues 与 specs 使用仅本地维护、不被 Git 跟踪的 `.x-matt/work/` Local Markdown。见 `.x-matt/agents/issue-tracker.md`。
已完成的 parent spec 只能由用户显式运行 `matt-archive` 归档；默认把 `.x-matt/work/shipped/` 视为不存在，只有用户在同一会话点名具体归档标题或路径时才可只读该对象。

### Triage labels

使用 canonical label/status vocabulary。见 `.x-matt/agents/triage-labels.md`。

### Domain docs

使用 single-context 布局。见 `.x-matt/agents/domain.md`。
