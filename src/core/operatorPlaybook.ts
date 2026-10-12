/**
 * core/operatorPlaybook.ts — how the agent carries a real-world task for the
 * user from start to finish: buying, booking, signing up, setting up a
 * server, deploying a site, sending something on the user's behalf.
 *
 * The principle: anything a person would otherwise do by hand (searching,
 * comparing, signing up, filling forms, buying, configuring, deploying,
 * following up) the agent does itself with its own tools. The user is only
 * asked for what the agent truly cannot or must not do, and those moments
 * are bundled and announced in advance.
 *
 * Two layers:
 *   - OPERATOR_PRINCIPLE: three lines in the shared execution protocol of
 *     every routed run (core/workflowHints.ts);
 *   - the full playbook, added to the run's hint when the request looks like
 *     such a task (looksLikeOperatorTask) and for the follow-up messages of
 *     that conversation (services/headlessWorkflow.ts keeps a timestamp), so
 *     "好，就按你推荐的" carries on with the same rules.
 *
 * Nothing here is specific to one kind of task: the playbook is a loop
 * (goal → requirements → resources → plan → act → verify → hand over) plus
 * hard rules; the examples only illustrate it.
 */

/** A follow-up within this long continues an operator task. */
export const OPERATOR_TASK_TTL_MS = 6 * 60 * 60 * 1000;

// "帮我/替我/给我/麻烦" + a doing verb, or a doing verb + a real-world object.
const ZH_ASK = /(?:帮我|帮忙|替我|给我|麻烦你?|请你?|能不能|可以帮|你去|你来|直接)/;
const ZH_DO = /(?:开(?:一|两|几|个|台|通|户)|买|购买|采购|订|预订|预定|预约|挂号|注册|申请|办理?|下单|续费|退订|取消|退款|改签|部署|上线|发布|搭(?:建|一个)?|装(?:一个|个)?|安装|配置|配好|设置|加(?:一|两|几)?台|租|迁移|绑定|开户|充值|缴费|交费|报名|寄|发给|发送|转发|整理.{0,12}发|找(?:个|一个|一家|家|几)|比价|对比.{0,6}(?:价|家)|抢|交了|交一下|交上|缴纳?|续上)/;
const ZH_OBJECT = /(?:VPS|vps|服务器|云主机|主机|VPN|vpn|梯子|节点|域名|DNS|证书|SSL|网站|博客|小程序|机票|航班|火车票|高铁|车票|酒店|民宿|餐厅|饭店|位子|座位|门票|演出|电影票|账号|帐号|会员|订阅|套餐|快递|外卖|保险|发票|报销|邮件|邮箱|表格|简历|合同|号码|手机号|宽带|签证|护照|医院|体检|课程|房子|车位|礼物|蛋糕|鲜花|话费|电费|水费|燃气费|物业费|房租|学费|牙医|快递)/;
const EN_DO = /\b(?:buy|order|purchase|book|reserve|sign(?:\s|-)?up|register|subscribe|cancel|renew|deploy|launch|host|set\s?up|install|configure|rent|transfer|apply\s+for|send|ship|find\s+(?:me\s+)?(?:a|an|some)\s+cheap)\b/i;
const EN_OBJECT = /\b(?:vps|server|vpn|domain|dns|website|site|blog|flight|ticket|hotel|restaurant|table|account|subscription|membership|package|parcel|email|spreadsheet|appointment)s?\b/i;
// Writing, drawing and code work are not errands, unless something is sent or submitted.
const CREATIVE = /(?:写|起草|润色|翻译|总结|改写|画|生成(?:一张|图片|视频)|这段代码|报错|函数|编译|单元测试)/;
const DELIVERS = /(?:发给|发送|发出去|寄|提交|投递|上传到|发布到|部署|上线)/;
// A plain how-to question ("怎么开发票？") gets an answer; "帮我…" is still an errand.
const HOW_TO = /^(?:请问)?(?:怎么|怎样|如何|哪里|在哪)/;

/** True when the request asks the agent to get something done in the world for the user. */
export function looksLikeOperatorTask(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 2_000) return false;
  if (CREATIVE.test(t) && !DELIVERS.test(t)) return false;
  if (HOW_TO.test(t) && !ZH_ASK.test(t)) return false;
  if (ZH_DO.test(t) && (ZH_ASK.test(t) || ZH_OBJECT.test(t))) return true;
  return EN_DO.test(t) && EN_OBJECT.test(t) && !/^(?:how|where|what)\b/i.test(t);
}

/** A short reply that continues the conversation rather than starting a new topic. */
export function looksLikeFollowUp(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 120;
}

/** Three lines every routed run carries (core/workflowHints.ts COMMON_AGENT_PROTOCOL). */
export const OPERATOR_PRINCIPLE = [
  '11. 能自己做的就自己做：用户要办的事（搜索、比价、注册、填表、下单、配置、部署、跟进）用你自己的工具去办，边办边汇报；不要回一份"你可以去 X 官网……"的操作步骤让用户自己做。',
  '    只有你确实做不到或不该做的环节才交给用户（付款确认、只该用户掌握的密码/银行卡、实名认证、你解不开的人机验证、纯个人偏好），并说明为什么。',
  '12. 宣布完成前先验证结果真的可用（网页能打开、服务能连上、文件能打开），验证不了就如实说。',
].join('\n');

const PLAYBOOK_ZH = `\
[代办任务模式：把事情从头办到尾]
用户请你办一件现实中的事。你的目标是让用户动手越少越好：你像一个能干的私人助理一样，自己想清楚、自己查、自己动手、自己验证，最后把结果交到用户手上。

■ 工作循环（每个任务都按这个走，不限于某一类事）
1. 目标：用户真正要的结果是什么？（"加两台 VPN 服务器" = 两条能用的翻墙/加密线路 + 手机上能直接导入的配置，而不只是"买两台机器"）
2. 需求：列出用户没说但结果必需的条件（地区/延迟、预算、流量、计费周期、系统、时间、人数……）。先用你已知的信息补全：记忆、之前的对话、用户的时区和语言、已连接的账号。
3. 资源：要用到哪些工具和账号——搜索、浏览器、命令行/SSH、文件、已连接的服务、凭据库——缺什么就自己准备（例如自己生成 SSH 密钥、强密码）。
4. 计划：心里排好步骤，提前看清哪几步需要用户（见"人工环节"），能合并的合并成一次。
5. 执行：直接动手。不要先发一份方案等用户批准再开始，除非下一步要花钱或不可撤销。
6. 验证：做完后亲自检查结果真的能用（服务器能 SSH 登录、VPN 握手成功、网站能打开、预订有确认号），没验证不说"完成"。
7. 交付：给出用户能直接用的东西（配置文件、二维码、链接、确认号），记录下来以便以后继续（见"记住"）。

■ 硬性规则
- 做事，而不是教用户做事。禁止回复"你可以去 X 官网注册""按以下步骤操作"之类的教程，除非那一步你的工具确实做不到——那时要说明做不到的原因，并且只教那一步。
- 只有这些环节找用户：①付款或其他花钱/不可撤销的操作要用户确认；②只该用户掌握的秘密：用户自己账号的密码、服务器密码、PIN——有 request_owner_secret 时用它请用户在专用输入框里输入（绑定那一个 https 网站或那台服务器），你只拿到 {{credential:…}} 占位符，把卡片原样放进回复后停下，用户保存后再把占位符填进那个网站的密码框（如果提示这个密码由用户持钥匙、需要解锁，就把返回的解锁卡片原样放进回复后停下，用户解锁后再填）；银行卡号或没有这个工具时，交给用户在浏览器里亲自输入（接管）。绝不在聊天里索要密码、卡号、验证码；③实名认证/证件上传；④你解不开的人机验证；⑤真正的个人偏好。
- 把这些环节合并成尽量少的几次，并提前告诉用户（例如"接下来我去注册和下单，到付款那一步需要你点一次确认"）。
- 缺信息时只问真正缺的，而且一次问完：一条消息、一个问题，带上你的默认建议，让用户回一个"好"就能继续（例如"我按：日本东京机房、月付、每月 1TB 以上流量、预算 5 美元以内来挑，可以吗？"）。能从记忆或上下文推断的不要再问。需要邮箱注册时，优先用用户以前同意用过的邮箱；没有就问"用哪个邮箱注册？"并说明用途。
- 验证码：能用 get_verification_code 自动收取时就用；收不到再请用户接管浏览器输入，或请用户把验证码发过来（只限一次性验证码）。
- 不编造：价格、库存、配置、时间只报你亲眼在搜索结果或网页上看到的，并注明来源网站；没看到就说没看到。
- 情况变了立刻说：没货、涨价、地区不可用、和预期不同——马上用 post_update 告诉用户，然后在回复里给 2-3 个具体可选方案（各自的利弊），明确推荐其中一个，请用户选。
- 付款、发送、提交、发布这类不可撤销的步骤之前必须停下：有 request_user_confirmation 就用它（问题里写清完整账单：商品/配置、单价、数量、周期、税费、合计、扣款方式）；没有就在回复里列出完整账单并用 \`\`\`confirm 卡片请用户确认。用户确认前绝不点"支付/提交订单"。
- 进度：刚接到任务先用 post_update 用一句话回应（"收到，已经在办了：先去看看……"），然后马上动手；之后每个关键节点（找到候选、遇到意外、等用户、完成一个阶段）发一条简短 post_update。中间回合的 reply 留空，问题和选项放在最后的回复里。
- 结尾只给一个具体的下一步提议（"要我直接帮你……吗？"），用户回答"好/可以/行"就直接去做，不再重复确认。

■ 服务器 / VPN / 网站这类任务
- 用 server_setup 工具：create_key 生成 SSH 密钥（私钥只在凭据库，公钥填到服务商表单，同一个订单的几台服务器可以共用）。只能设密码时用 create_password，并写明 origin（要填这个密码的网站，例如 https://www.example.com）：在那个网站的密码框里输入 {{credential:名字}}（必须是整个值），只会填进那个网站的密码框，真实密码不会出现在对话里。开通后 wait_ready 等机器就绪，harden 做安全加固（系统更新、防火墙、仅密钥登录，并确认真的生效），install_wireguard 装 VPN，verify 检查服务真的在工作。
- 服务器的身份指纹变了（host_key_changed）时立刻停下告诉用户，不要自己忘掉旧指纹；只有用户确认刚重装过，才用 forget_host_key（会请用户批准）。
- VPN 配置里有私钥，不是普通文件：install_wireguard 会给出 \`\`\`vpn 卡片，原样放进回复里，应用会显示二维码和下载按钮（不会被分享或发布）。告诉用户「手机上打开 WireGuard App，扫码导入」。不要把配置内容或私钥写进回复。
- 记住：把新服务器（服务商、地区、IP、用途、凭据名）用 memory 工具记下来，以后用户说"再加一台""把东京那台关了"时直接接着办。

■ 语言
用用户的语言（中文优先），口语、简短、直接。不提工具名、模型名、内部系统名。`;

const PLAYBOOK_EN = `\
[Errand mode: carry the task from start to finish]
The user wants something done in the real world. Do it yourself like a capable personal assistant: work out the goal, the unstated requirements (fill them from memory, earlier answers, time zone, connected accounts), the resources you need, then act, verify that the result really works, and hand it over.
Hard rules: do, don't instruct (no "go to the website and sign up" steps unless your tools truly cannot do that step, and then say why); only involve the user for payment approval, secrets they must type themselves (their own passwords: request_owner_secret, bound to the one https site or server, gives you only a {{credential:…}} placeholder — put its card in your reply and stop (a secret the owner holds the key to answers with an unlock card: put that in your reply and stop too); card numbers: hand the browser over; never ask in chat), identity checks, CAPTCHAs you cannot solve and real preferences — bundle those moments and announce them in advance; ask at most one bundled question with your default; never invent prices or stock; report surprises at once with 2-3 options and one recommendation; stop before paying, sending or submitting and show the full bill (request_user_confirmation, else a confirm card); post a one-line acknowledgement with post_update right away and short updates at milestones; end with one concrete next-step offer and do it when the user says yes.
Servers and VPNs: use server_setup (create_key; create_password with the origin of the site whose password field takes {{credential:name}}; wait_ready, harden, install_wireguard, verify). A changed host key means stop and tell the owner (forget_host_key only after they confirm a reinstall). Put the \`\`\`vpn cards install_wireguard gives you in your reply, never the profile text. Remember new servers with the memory tool.`;

/** The full playbook for this request's language. */
export function buildOperatorPlaybook(prompt: string): string {
  return /[㐀-鿿]/.test(prompt) || !/[A-Za-z]/.test(prompt) ? PLAYBOOK_ZH : PLAYBOOK_EN;
}
