# compute_job schema 修复记录

## 问题背景

OpenScience 2.0.27 中 `compute_job` 工具的参数 schema 是根级
`z.discriminatedUnion("action", ...)`。当插件系统把工具 schema 转换成
OpenAI function 格式时，根节点会变成 `type: null`，DeepSeek 会拒绝请求：

```text
Invalid schema for function 'compute_job': schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

`compute_job` 是 JobBroker 的核心工具，用于规划、启动、检查和控制本地、
SSH/Slurm/PBS、Modal 等目标上的项目计算任务。因此不能长期在插件里禁用。

## 修复思路

上游 OpenScience `main` 分支已经包含正确修复：运行时仍使用
action-specific 的 discriminated union 做校验，但对外暴露的 JSON Schema
使用普通 object 根节点。本修复基于 v2.0.27 源码，只替换
`compute-job.ts` 为上游 `main` 版本，重新构建单平台二进制，并移除插件侧
`compute_job: false` 的临时 workaround。

## 变更内容

1. 删除插件 `dsh-openscience.ts` 中的 `MINIMAL_TOOLS` 常量。
2. 删除 `onChatMessage` 中所有 `output.message.tools = MINIMAL_TOOLS`
   的分支。
3. 保留模型检测 fallback：
   - `resolveMode` 在 model 未知时保留当前 mode。
   - `onChatMessage` 使用 `input.model ?? output.message.model` 做 mode 检测。
4. 重新构建 OpenScience v2.0.27 二进制，应用上游 `compute-job.ts` 修复。
5. 备份并替换 `~/.openscience/bin/openscience`。

## 操作步骤

### 1. 清理插件侧 workaround

在 `/home/ubuntu/dsh-minimal-openscience/dsh-openscience.ts` 中：

- 删除 `MINIMAL_TOOLS` 常量及其注释。
- 删除 synthetic 分支中的：

  ```ts
  } else if (current.mode === "minimal") {
    output.message.tools = MINIMAL_TOOLS
  }
  ```

- 恢复 minimal 分支为不 gate：

  ```ts
  // minimal: no gating; leave the full native tool surface enabled.
  ```

保留：

```ts
if (modelHaystack(model).length === 0) {
  // Model unknown ...
  return existing?.mode ?? "off"
}
```

和：

```ts
resolveMode(sessionID, input.model ?? output.message.model)
```

### 2. 克隆 v2.0.27 源码并替换 compute-job.ts

```bash
git clone --depth 1 --branch v2.0.27 \
  https://github.com/synthetic-sciences/openscience.git /tmp/openscience-src

curl -L \
  https://raw.githubusercontent.com/synthetic-sciences/openscience/main/backend/cli/src/tool/compute-job.ts \
  -o /tmp/openscience-src/backend/cli/src/tool/compute-job.ts
```

### 3. 构建单平台二进制

```bash
cd /tmp/openscience-src
bun install
./backend/cli/script/build.ts --single
```

构建产物预期位置：

```text
backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience
```

### 4. 验证 patched schema

```bash
cd /tmp/openscience-src/backend/cli
bun --conditions=browser -e '
  import { z } from "zod";
  import { ComputeJobParameters } from "./src/tool/compute-job.ts";
  const schema = z.toJSONSchema(ComputeJobParameters);
  console.log(JSON.stringify({
    type: schema.type,
    hasAnyOf: Array.isArray(schema.anyOf),
    actions: schema.properties?.action?.enum
  }, null, 2))
'
```

预期输出：

```json
{
  "type": "object",
  "hasAnyOf": false,
  "actions": [
    "targets",
    "plan",
    "start",
    "list",
    "status",
    "logs",
    "artifacts",
    "cancel",
    "retry_delivery",
    "release"
  ]
}
```

如果输出仍是根级 `anyOf` 或 `type` 不是 `object`，不要安装，先排查构建。

### 5. 备份并安装 patched 二进制

```bash
cp ~/.openscience/bin/openscience ~/.openscience/bin/openscience.bak-v2.0.27
install -m 755 \
  /tmp/openscience-src/backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience \
  ~/.openscience/bin/openscience
~/.openscience/bin/openscience --version
```

> 注意：v2.0.27 源码构建出的版本号可能是 `0.0.0--YYYYMMDDHHMM`
> 这类开发构建字符串，不影响功能。

### 6. 验证插件

```bash
cd /home/ubuntu/dsh-minimal-openscience
bun x tsc --noEmit dsh-openscience.ts \
  --module esnext --moduleResolution bundler --target esnext \
  --strict --skipLibCheck --types node
bun build dsh-openscience.ts --target bun --outfile /dev/null
```

运行 smoke test（如果存在）：

```bash
bun /tmp/dsh-smoke.ts
```

启动 patched host 并确认插件加载：

```bash
~/.openscience/bin/openscience serve --port 17890 --log-level INFO
curl -s http://127.0.0.1:17890/session
grep -i "dsh-openscience" ~/.openscience/log/*.log
```

日志中应看到：

```text
path=file:///home/ubuntu/dsh-minimal-openscience/dsh-openscience.ts loading plugin
```

### 7. DeepSeek 端到端验证

启动 OpenScience 后，使用 DeepSeek 发送一条简单消息。本次验证使用
`deepseek-v4-pro`，运行最终收到 `runtime.completed`，日志中没有出现：

```text
Invalid schema for function 'compute_job'
```

## 回滚方式

如果 patched 二进制出现问题，可恢复备份：

```bash
cp ~/.openscience/bin/openscience.bak-v2.0.27 ~/.openscience/bin/openscience
```

## 验证结果摘要

- [x] 插件 diff 已移除 `compute_job: false` workaround
- [x] schema probe：`type: "object"`、`hasAnyOf: false`、10 个 action
- [x] 插件 `tsc` 和 `bun build` 通过
- [x] smoke test 通过，minimal 模式 `message.tools === undefined`
- [x] patched host 成功加载插件，无 plugin error
- [x] DeepSeek 端到端请求完成，无 compute_job schema 错误
