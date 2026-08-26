---
name: research
description: 将需要一手外部证据的问题交给受限 researcher 子代理，并在父会话中综合结果。用于调查官方文档、规范、源代码、第一方 API 或近期生态事实。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/research/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Research

父会话拥有问题定义、调度和最终判断；子代理只执行资料调查。

## 调度

1. 把用户问题收敛为一个明确、可验证的研究目标。
2. 调用项目工具 `pi_matt_dispatch`：
   - `workflow`: `research`
   - `task`: 写明问题、时间边界、必需资料类型、输出格式和停止条件
3. 调度完成后继续处理不依赖结果的工作，或把控制权交还用户等待异步完成。
4. 收到 completion result 后，只读取 research lane 的 `structuredOutput`；不要把普通 `output`、`outputReference` 或文件扩展名当作结构化结果。
5. 若 run 失败、lane 缺失或 `structuredOutput` 不是符合 workflow schema 的对象，明确报告工作流失败，不回退到自然语言报告。
6. 结构化结果有效时，检查来源是否为一手资料、每项关键结论是否可追溯、未知项是否明确标注，然后再回答用户。

## 边界

- 不直接调用未经过 registry 校验的同名 leaf skill。
- 不让 researcher 创建其他子代理。
- 不把子代理报告当作决策授权。
- 工具不可用或 registry 拒绝时应明确失败，不回退到暴露全部 skills。
