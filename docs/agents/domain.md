# Domain Docs

本仓库使用 single-context 领域文档布局。

## 探索前读取

按相关性读取：

- 根目录 `CONTEXT.md`
- 根目录 `CONTEXT-MAP.md`（若未来存在，则按 map 读取相关 context）
- `docs/adr/` 中与目标区域相关的 ADR

文件不存在时静默继续；不要为满足布局而创建空文件。`domain-modeling` 会在术语确定或决定通过 ADR gate 时按需创建。

## Single-context 布局

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

`CONTEXT.md` 保存 canonical domain terms，不保存 spec、计划、测试或实现流水账。`docs/adr/` 只保存难逆转、令人意外且存在真实备选方案的决定。

## 使用规则

- issue 标题、ticket、测试和设计输出使用 glossary 中的 canonical term。
- 不使用 glossary 明确标记应避免的同义词。
- 需要的概念尚未定义时，记录为 domain-modeling 的待决项，不自行发明长期术语。
- 输出若与现有 ADR 冲突，必须明确指出对应 ADR 和冲突原因，不得静默覆盖。
