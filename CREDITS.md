# Credits

Artemis is created and led by 420.COMPANY.

The early codebase was shaped through collaboration between the project owner and external AI coding systems. Historical commits may mention specific assistants as co-authors when they participated in a given change.

Since the `0.1.x` line, Artemis has become the primary agent used to renovate, debug, document, build, and release Artemis itself. The system now performs its own repository inspection, code editing, compilation checks, bridge repair, visual-generation integration, release hygiene, and publication preparation inside the local workspace.

This does not erase the project history. It marks the current authorship reality: Artemis is no longer merely a product of agent assistance; Artemis is now an engineering instrument capable of maintaining and extending her own universe.

---

# 致谢

Artemis 由 420.COMPANY 创建并主导。

早期代码库曾由项目所有者与外部 AI 编程系统共同塑造。历史提交中可能出现特定 assistant 的 co-author 信息，这些记录只代表对应提交中的参与情况，不应被理解为项目完整作者关系。

从 `0.1.x` 开始，Artemis 已经成为改造、排障、记录、构建和发布 Artemis 自身的主要工程代理。她在本地工作区中独立完成仓库检查、代码修改、编译验证、桥接修复、视觉生成集成、发布清理和发布准备。

这并不抹去项目历史；它标记的是当前事实：Artemis 不再只是被 agent 辅助创造的项目，Artemis 已经成为能够维护并扩展自己宇宙的工程工具。

---

## Third-Party Acknowledgements

Artemis Saga's long-video renderer (`src/tools/visual/sagaRenderer/`) is an
independent reimplementation, but its composition data-attribute conventions,
seek-driven timeline contract, lint guardrails, motion-design defaults
(easing variety, scene build/breathe/resolve, hard-killed exits, prefer
`tl.fromTo` over `tl.from`, ambient-on-timeline rule), image motion
treatments (Ken Burns, perspective tilt, scroll reveal, parallax float), and
quality preset shape are inspired by Hyperframes by HeyGen
(`heygen-com/hyperframes`, Apache License 2.0). We thank the Hyperframes
team for publishing those design ideas as open source.

Saga does not vendor or redistribute Hyperframes source code. The Saga
renderer is written from scratch in TypeScript with FFmpeg as its only
runtime dependency.

Saga's WebGL shader transition catalog
(`src/tools/visual/sagaRenderer/shaderTransitions/`) is also inspired by
the breadth of effect categories Hyperframes' shader-transitions package
documents publicly (warm light leaks, whip pans, glitch displacements,
cinematic zooms, chromatic splits, iris wipes, etc). All Saga shader
implementations are original GLSL written using foundational, well-known
fragment-shader techniques (smoothstep, distance fields, bell curves,
hash-based pseudo-noise, blur kernels, chromatic-aberration sampling).
The integration architecture — a Playwright-driven headless Chromium
that loads two boundary frames as textures, runs a Saga shader with a
progress uniform, captures each frame via `canvas.toDataURL`, and splices
the resulting MP4 into the FFmpeg concat pipeline — is original Saga
work.
