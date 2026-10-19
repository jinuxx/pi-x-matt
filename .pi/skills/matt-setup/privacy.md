# 业务项目的本地 AI 隐私契约

本契约约束使用 pi-x-matt 的业务项目：只提交业务代码、测试及明确批准的业务文档，不提交个人 AI 工作资料或使用工具的归因信息。它是流程与 Git 防误提交规则，不是文件访问沙箱。

## 作用范围

先用已加载 skill 的绝对 location 定位 package root，再比较真实路径；只有目标 cwd 的真实路径与该 package root 完全一致时才属于插件源码仓库例外。该例外保留 `.pi/skills`、dispatcher、README、AGENTS 与源码维护契约的正常版本控制，不把发布源文件整体忽略。不能只凭目录名、`package.json#name` 或一个开关声明例外。

业务项目默认保护整个 `.x-matt/` 与个人 `.pi/`：tracker、领域词汇、ADR、research notes、原型、截图、会话/评审报告、settings、Pi package 声明与本地入口均只在本机保存。这里指 Pi 的 package/extension/skill 配置，不是业务的 `package.json`、构建配置或锁文件——后者是业务源码，绝不纳入忽略范围。不向业务源码复制工作流记录、工具清单或 harness 说明，不修改团队 `AGENTS.md`、README 或其他共享文档来添加 AI 入口。业务本身确实需要的 AI 功能不受术语禁用；本规则针对开发工具元信息，不机械删除业务语义。

团队若确实需要共享某项 `.pi` 资源（例如全员共用的 MCP 或自写 skill），那是需要用户显式决定的范围变化，不是本契约的默认能力。Git 无法在已被排除的父目录内用 `!` 重新包含单个文件，所以逐条共享必须改变规则形态，而不能只是“加一条例外”：setup 先停止、说明该文件会暴露工具信息；用户明确批准后，把 `/<前缀>.pi/` 换成更细的本机规则（保留其余个人条目的忽略），并记录决定与条目清单。核验必须双向：个人文件仍被忽略（`git check-ignore` 匹配）且未被跟踪（`git ls-files` 为空）；已批准共享条目则 `git check-ignore` 不匹配，且按用途选择证据——尚未跟踪的新条目用 `git add --dry-run` 确认可暂存，已跟踪的条目用 `git ls-files --error-unmatch` 确认仍在索引。任一方向不符即停止，不得把“整目录仍被忽略”当成共享成功，也不得静默把整目录改成默认白名单。

## Git exclude 与迁移

- 用 `git rev-parse --git-path info/exclude` 定位本机文件，不能假定 `.git` 是目录；用 `git rev-parse --show-prefix` 得到项目相对 Git root 的前缀。保留原文、避免重复，追加 `/<前缀>.x-matt/` 与 `/<前缀>.pi/`；根项目为 `/.x-matt/` 与 `/.pi/`。支持 nested project 和 linked worktree，不修改团队 `.gitignore`。
- 核验规则匹配真实/计划文件（`git check-ignore --no-index`）且私有文件未被跟踪（`git ls-files`）；存在已批准共享条目时，还要按上文的双向断言确认它们确实可跟踪。ignore 不会隐藏已有 tracked 文件；若有规则冲突或团队已跟踪 `.pi/` 内容，先报告并停止，不能以忽略配置成功冒充隐私完成。
- 已有个人 tracked 文件必须展示精确迁移清单，经授权后仅取消索引跟踪、保留磁盘，不删除文件、不重写历史；团队原有配置不能一并取消跟踪。旧共享 AGENTS/README 中的个人入口需经用户确认后仅删除对应 block，保留团队正文；历史中已有的内容仍然存在。
- 其他已有个人 harness 配置（如根目录 AGENTS/CLAUDE 指令或 `.claude/`）按证据列入迁移清单，批准后追加精确本机 exclude；不凭文件名删除团队资料，不把整个 README、package manifest 等业务文件忽略。
- 取消跟踪的索引删除由用户提交迁移后再进入 implement/archive；新 clone/worktree 需重新核验保护是否有效。本机资料需自行备份，不靠 Git 传播。
- 已忽略资料按准确路径直接读取，不能用 Git-aware 搜索或 diff 未包含它们推断不存在。shipped 默认不可见规则不变，不为隐私迁移读取或枚举归档正文。

## 本地入口

使用受信任项目的 `.pi/APPEND_SYSTEM.md` 中唯一 `## Agent skills` block 指向 `.x-matt/agents/`。保留此文件已有正文；不创建或编辑共享根 AGENTS，不使用 `AGENTS.override.md` 遮蔽团队指令。已有团队 AGENTS 仍是工程规范，正常只读加载。

Pi 的 project APPEND_SYSTEM 会优先于同名 user-level 文件，二者不会合并。若本地 project 文件不存在而全局 APPEND_SYSTEM.md 存在，创建 project 文件会遮蔽全局内容：先停止并说明影响，取得用户对保留/合并方式的明确决定，再展示完整 draft；不能静默丢弃全局指令。已有 project 文件只原位更新本工具 block。不得把 secrets 复制到入口文件。

setup 写前确认同时展示本地入口、`.x-matt/agents/` 契约、exclude 与 tracked 迁移范围；写后重读、核验私有路径未暂存，提示 `/reload` 后由 Pi 加载本地入口。未受信任或缺少入口时不能宣称自动加载成功。

## 写入、验证与提交

所有父流程在落盘前确认本契约适用范围与保护已就绪；domain/ADR/research 等资料不能因不属于 tracker 就被带进提交。worker、reviewer 获得的 Context Pack 必须包含本次私有路径与禁止外泄边界。

提交前逐项检查完整 staged manifest、完整 staged diff 与最终提交信息，不能只检查文件名：业务项目不得包含 `.x-matt/`、个人 `.pi/`、工具/harness/model 名称、session ID、私有路径、自动 AI attribution 或工具生成的 `Co-authored-by`。不要把业务合理需要的同名词或正常人工共同作者误判为工具归因；不伪造作者、不剥除团队要求的身份/签名。

提交后核对实际 commit 的 files、message/trailers 与元信息。若 hook/其他扩展追加了未授权工具归因或改变范围，停止、不 push，报告真实提交并让用户决定如何处理；不擅自 amend、不关闭团队 hook、不重写已发布历史。

本契约不承诺抹去历史，也不能保证用户手动操作、第三方扩展、Git hook、远端日志或服务端策略完全无痕。发现这些范围的残留或强制归因时须明确报告，不能声称“绝对不会被发现”。
