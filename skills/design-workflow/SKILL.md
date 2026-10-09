---
name: design-workflow
description: Artemis design workflow. Use it when the user wants a website, landing page, app screen, dashboard or other visual front end built or restyled; Artemis also loads it automatically when the request is routed to the design workflow.
---

# 设计工作流（视觉 / 前端工程）

偏向网页、UI、品牌视觉、交互、动画类任务。按以下方式工作：

• 先确认/创建工作目录（如用户提到 "桌面/futuretest" 之类，先 mkdir + run_command 切换工作区）
• 用 todo 拆解：事实来源/信息架构、资产清单、风格系统、页面实现、响应式、视觉验收、收尾
• 开始前先列"内容事实清单"：用户明确给了什么、代码库/README 里能确认什么、哪些未知。未知内容不得补成事实
• **禁止虚构**：不要编产品名、指标、命令、安装地址、版本号、团队规模、社交链接、年份和路线图。用户只给 Artemis CLI 时，不要捏造 Nyx/Styx/Aether 这类产品；可以做"产品/项目待补充"或只介绍 Artemis
• **生图与代码并行**：先写任务专属资产 manifest（画幅、用途、主体、风格、验证），再调 generate_image，同时写 HTML/CSS/JS
• **视觉 prompt 必须动态生成**：每次从用户原文和项目事实中提取本轮主体、用途、受众、风格、构图、材质、光线、画幅、禁止项，再组成 generate_image/generate_video 的 prompt；不要套用固定题材词表、固定业务关键词或历史任务关键词
• 配图要求默认 ≥3 张本地生成（hero、section background、细节素材）；若 generate_image 失败，必须明确降级，并且最终不能写"配图就绪/全部验证通过"
• HTML 用语义化标签；CSS 用现代特性（grid/flex/clamp/aspect-ratio/container query 可用则用）；JS 只处理真实交互，不堆装饰脚本
• 不允许写出空 styles.css 或仅有 reset 的 CSS；每个 section 都要有真正的视觉处理、明确层级和响应式状态
• 不允许写"// TODO"、"占位文案"、href="#"、假按钮、不可达导航；所有内容必须来自用户主题或明确标注为待补充
• 配色/字体/间距要形成系统：定义 CSS 变量集中管理，不要散在各处硬编码；核心布局不要靠大量 inline style
• 用户要求"高级感/电影质感/迷幻艺术/高奢/孤傲/科技感"时，要翻译为可执行设计技法：负空间、材料质感、光源方向、低饱和灰阶、精细网格、尺度反差、慢动效、弱装饰、强首屏主体；不要落成普通 SaaS 卡片堆
• 网站/应用的第一屏必须立刻表现品牌/产品/主题，不要只有口号和泛背景；移动端不能遮挡、溢出或变成散乱长文
• 写完必须做真实验收：启动服务后至少 browser_navigate + browser_screenshot 桌面视口和手机视口；HTTP 200、文件存在、curl 成功都不是视觉验收
• 截图/浏览器失败时，必须继续用可行替代动作恢复；仍失败则在最终说明"视觉验收未完成"，不得写"全部验证通过"
• 最终报告只写：文件位置、运行地址、实际验证证据、未验证风险；不要把清单重复成长报告
• 需要独立视角时，可以派 1 个 reviewer / critic 子代理（delegate_task）评审设计稿、截图或实现，并按它的问题清单修正；没有子代理工具时自己做一轮 critic 审查

🚫 禁止：先写"设计文档"再写代码；只写一个 index.html 凑数；用模板化营销文案冒充品牌设计；用假数据填满页面
