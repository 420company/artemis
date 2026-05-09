> **Historical document** — This describes the 0.1.92 dream-video integration upgrade. The dream video system has since been significantly extended. See `docs/RELEASE.md` for the current release notes.
> **历史文档** — 本文档描述 0.1.92 版本的梦境视频链路升级。梦境视频系统此后已大幅扩展，当前版本说明请参考 `docs/RELEASE.md`。

# Artemis 0.1.92 梦境视频链路升级说明

日期：2026-05-05
版本：0.1.92

## 背景

本次升级目标是把 Artemis 梦境系统与既有视觉视频生成系统打通，使“最新梦境 → 视频提示词 → 视频生成 → 梦境索引记录”成为一条原生、可检查、可追踪的链路。

此前梦境系统支持文字梦境和可选配图，但视频能力只存在于通用 `generate_video` 工具中，梦境系统自身没有稳定入口、没有最新梦境读取 API，也没有在梦境索引中记录视频产物。

## 改动范围

### 1. 梦境索引数据模型升级

文件：`src/services/dreamStore.ts`

新增字段：

```ts
videoPath?: string
```

影响：

- 梦境条目现在可以记录对应的 `.mp4` 视频产物。
- 删除梦境时会同步清理 `videoPath` 指向的视频文件。
- `buildDreamPaths(id)` 现在同时返回：
  - `mdPath`
  - `imagePath`
  - `videoPath`

### 2. 新增梦境条目更新能力

文件：`src/services/dreamStore.ts`

新增：

```ts
updateDreamEntry(id, patch)
```

用途：

- 视频生成完成后，把 `videoPath` 写回对应梦境索引。
- 避免生成视频后产物和梦境正文脱节。

### 3. 新增最新梦境读取 API

文件：`src/services/dreamStore.ts`

新增：

```ts
findLatestDreamEntry()
findLatestDreamBody()
```

用途：

- 从 `index.json` 中稳定选择最新仍存在正文文件的梦境。
- 避免用文件 mtime 猜测最新梦境。
- 为后续“分享最新梦境”“回放最新梦境”“生成最新梦境视频”等功能提供统一基础。

### 4. 新增梦境视频服务

文件：`src/services/dreamVideo.ts`

新增能力：

```ts
checkDreamVideoCapability(cwd)
generateDreamVideo(options)
```

核心链路：

1. 选择指定梦境，未指定时选择最新梦境。
2. 检查本地 visual video provider 是否可用。
3. 读取梦境正文并压缩为视频 brief。
4. 复用现有 `buildDirectedVideoPrompt` 生成结构化视频提示词。
5. 调用现有 visual provider 的 `generateVideo()`。
6. 支持 provider 返回本地路径、HTTP URL 或 data URL。
7. 保存视频到 `~/.artemis/dreams/<dream-id>.mp4`。
8. 更新梦境索引中的 `videoPath`。

### 5. CLI 接入 `/dream video`

文件：`src/cli/interactive.ts`

新增命令：

```text
/dream video
/dream video <id>
/dream video-status
```

行为：

- `/dream video`：使用最新梦境生成视频。
- `/dream video <id>`：使用指定梦境生成视频。
- `/dream video-status`：检查梦境视频生成能力，包括 provider、model 和配置来源。

同时：

- `/dream list` 增加图标显示：
  - `🎞` 有视频
  - `🖼` 有图片
  - `📝` 仅文本
- `/dream status` 的最近梦境列表也显示视频状态。
- 新梦境生成结果面板会显示已记录的视频路径字段。

## 兼容性说明

- 默认梦境生成行为未改变：`composeDream()` 仍只负责文字和可选配图，不会自动生成视频，避免空闲触发时产生额外视频成本。
- 视频生成为显式命令触发：`/dream video`。
- 旧版 `index.json` 没有 `videoPath` 字段仍可正常读取。
- `removeDreamEntry()` 对没有 `videoPath` 的旧条目保持兼容。

## 隐私与安全

本次改动不引入新的凭证文件，也不把 API key、token、URL 等敏感信息写入梦境正文或改动说明。

清理检查：

```text
find . -maxdepth 3 \( -name '*.tmp' -o -name '*.log' -o -name '*.bak' -o -name '*.backup' -o -name '*.orig' -o -name '.DS_Store' -o -name '*.tgz' \) -print
```

结果：未发现需要清理的垃圾文件或临时包文件。

补充：`.gitignore` 与 `.npmignore` 已覆盖 `.artemis/`、`.mylaude/`、环境文件、日志、临时文件和 npm tarball，避免用户数据与凭证进入 Git 或 NPM 包。

## 验证记录

已执行：

```text
npm run typecheck
npm run lint
npm run test:all
npm run build
npm pack --dry-run
```

结果：全部通过。

其中 `test:all` 覆盖：

- system smoke
- prompt smoke
- runtime smoke
- query engine smoke
- feature smoke
- workspace intent smoke

打包验证：`npm pack --dry-run` 成功生成 dry-run tarball 预览。

## 已知边界

- 视频生成质量仍取决于用户配置的 visual video provider 和模型能力。
- `/dream video` 是显式触发，不会在 idle dream 自动执行。
- 本次没有新增真实 provider API 调用单元测试；真实生成已在人工验收阶段用最新梦境通过 BytePlus `dreamina-seedance-2-0-fast-260128` 生成成功。

## 关联文件

- `src/services/dreamStore.ts`
- `src/services/dreamVideo.ts`
- `src/cli/interactive.ts`
- `package.json`
- `package-lock.json`

## 发布信息

- NPM 版本：`0.1.92`
- Git tag：`v0.1.92`

发布完成后应记录：

```text
npm publish
npm: artemis-code@0.1.92
GitHub: main pushed with tag v0.1.92
```
