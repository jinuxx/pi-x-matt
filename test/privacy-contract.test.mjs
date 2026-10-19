import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(ROOT, path), "utf8");

test("business-project privacy covers all personal AI resources without hiding package source", async () => {
  const privacy = await read(".pi/skills/matt-setup/privacy.md");
  assert.match(privacy, /真实路径.*package root.*一致/);
  assert.match(privacy, /插件源码仓库.*例外/);
  assert.match(privacy, /整个 `\.x-matt\/`.*个人 `\.pi\/`/);
  assert.match(privacy, /`\/<前缀>\.x-matt\/`.*`\/<前缀>\.pi\/`/);
  assert.match(privacy, /不修改团队.*AGENTS\.md.*README/);
  assert.match(privacy, /不重写历史/);
  assert.match(privacy, /已有.*tracked.*授权.*保留磁盘/);
  assert.match(privacy, /不能保证.*第三方/);

  const setup = await read(".pi/skills/matt-setup/SKILL.md");
  assert.match(setup, /\[.*隐私.*\]\(privacy\.md\)/);
  assert.match(setup, /\.pi\/APPEND_SYSTEM\.md/);
  assert.match(setup, /全局.*APPEND_SYSTEM\.md.*遮蔽.*停止/);
  assert.doesNotMatch(setup, /根目录已有 `AGENTS\.md` 时更新|询问是否创建项目级 `AGENTS\.md`/);
});

test("business commits check private paths, content and attribution without falsifying authors", async () => {
  const implement = await read(".pi/skills/matt-implement/SKILL.md");
  assert.match(implement, /privacy\.md/);
  assert.match(implement, /完整 staged manifest.*staged diff.*提交信息/);
  assert.match(implement, /Co-authored-by|AI attribution/);
  assert.match(implement, /hook.*停止.*不 push/);
  assert.match(implement, /不伪造作者|不修改作者身份/);
  assert.match(implement, /唯一例外是源码维护例外下.*需分发的 `\.x-matt\/` 契约文件/);
  assert.match(implement, /force-add 集合恰好就是这些路径.*完整 staged manifest 只含本次计划内文件/);
  const pack = await read(".pi/skills/matt-tdd/context-packs.md");
  assert.match(pack, /隐私.*worker.*reviewer/);
});

test("prototype artifacts stay on a local only branch and never enter shared history", async () => {
  const prototype = await read(".pi/skills/matt-prototype/SKILL.md");
  assert.match(prototype, /原型提交只存在于本机 `prototype\/<slug>` 分支/);
  assert.match(prototype, /禁止 push、PR、merge 或 rebase 进共享分支/);
  assert.match(prototype, /不把 `\.x-matt\/` 内容、工具名或 harness 说明写进业务文件与提交信息/);
  assert.match(prototype, /不创建 branch、不 commit、不 stage、不 push/);
});

test("business ignore never covers business manifests and keeps shared .pi intent explicit", async () => {
  const privacy = await read(".pi/skills/matt-setup/privacy.md");
  assert.match(privacy, /不是业务的 `package\.json`、构建配置或锁文件.*绝不纳入忽略范围/);
  assert.match(privacy, /团队若确实需要共享某项 `\.pi` 资源.*不是本契约的默认能力/);
  assert.match(privacy, /无法在已被排除的父目录内用 `!` 重新包含单个文件/);
  assert.match(privacy, /换成更细的本机规则/);
  assert.match(privacy, /已批准共享条目则 `git check-ignore` 不匹配.*新条目用 `git add --dry-run`.*已跟踪.*`git ls-files --error-unmatch`/);
  assert.match(privacy, /不得静默把整目录改成默认白名单/);
});

test("source-repo exception excludes the whole .x-matt directory only", async () => {
  for (const path of [".x-matt/agents/issue-tracker.md", ".pi/skills/matt-setup/SKILL.md", "README.md"]) {
    const content = await read(path);
    assert.match(content, /整个 `\.x-matt\/`/, path);
    assert.match(content, /\.pi\/` 作为 package 源码保持跟踪/, path);
    assert.doesNotMatch(content, /\.x-matt\/research\/`、`\.x-matt\/prototypes\//, path);
  }
});
