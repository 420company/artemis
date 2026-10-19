// Style DNA distilled from the Lumina verification pass (68 videos, verified
// 2026-10-19: #1–#24 confirmed by the owner one by one, #25–#68 analysed from
// thumbnails plus full prompts after the Lumina player failed). Source
// library: 420company/artemis-app-saga-source, lumina-distillation/.
//
// Why data and not prose: the matcher needs fields (trigger words, forbidden
// elements, camera moves), and the enhancement block that reaches a segment
// prompt has to stay short. The markdown originals stay in the distillation
// package as provenance; this file is what Saga runs on.
//
// The owner's rule for all of it: analyse the request, infer the real intent,
// and when the knowledge matches, ENHANCE quality additively — never replace
// what the user asked for, and skip silently when nothing matches.

/** Video families the library covers. One request matches at most one. */
export type StyleCategory = 'hiphop-mv' | 'music-mv' | 'product-ad' | 'ugc-commerce' | 'explainer';

/**
 * How a style scored in the verification pass: an anchor is a worked example
 * (see QUALITY_ANCHORS), "mediocre" means a good idea with execution damage —
 * the cases where enhancement helps most.
 */
export type QualityMark = 'anchor-positive' | 'anchor-negative' | 'verified' | 'mediocre';

export type PrincipleId =
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12'
  | 'P13' | 'P14' | 'P15' | 'P16' | 'P17' | 'P18' | 'P19' | 'P20' | 'P21' | 'P22' | 'P23' | 'P24' | 'P25'
  | 'P26' | 'P27' | 'P28';

export type Principle = {
  id: PrincipleId;
  /** What the rule says, in the owner's own framing. */
  rule: string;
  /** What Saga should do about it when the rule applies. */
  action: string;
  /** Categories the rule applies to; 'all' is cross-style. */
  scope: StyleCategory[] | 'all';
  /** Lumina video numbers behind it. */
  evidence: string[];
  /**
   * A technique rather than a standing rule: it applies only when the request
   * asks for what it does. Without this gate a principle like P25 would tell
   * every music video to fly a drone through an explosion, which is the
   * "硬塞" the library forbids. A style may still list it unconditionally when
   * the move is native to that style (EDM and its FPV fly-through).
   */
  triggers?: string[];
};

export type StyleDna = {
  id: string;
  /** Chinese label first: it is what the owner reads in the plan. */
  label: string;
  category: StyleCategory;
  /** Matcher dictionary: artist names, places, era words, mood words. */
  triggers: string[];
  /** Elements the generated video should contain. */
  motifs: string[];
  palette: string;
  camera: string[];
  pacing: string;
  /** Elements the prompt must forbid (these become negative instructions). */
  antiPatterns: string[];
  principles: PrincipleId[];
  evidence: string[];
  quality?: QualityMark;
  /**
   * Umbrella styles ("animation MV") that cannot be generated as such: the
   * route has to be settled first (P24).
   */
  routes?: string[];
};

/**
 * The 24 transferable principles. They outrank a single style's DNA because
 * they hold across styles (the library's own words: "第一优先级规则集").
 */
export const STYLE_PRINCIPLES: readonly Principle[] = [
  // 一、真实感与物理
  { id: 'P1', scope: 'all', evidence: ['#9'],
    rule: '现实场景的高清真实感是迷幻融合的前提：现实部分没质感，整片就廉价',
    action: '出现「现实 + 超现实融合」需求时，先保证现实部分的摄影质感（清晰度、光影、材质），再叠迷幻元素' },
  { id: 'P2', scope: 'all', evidence: ['#9'],
    rule: '迷幻元素要长在现实场景里，不要全屏覆盖（全屏迷幻 = 绿幕棚拍感）',
    action: '把超现实元素限制在局部，与真实场景结合，不做全画面特效覆盖' },
  { id: 'P3', scope: 'all', evidence: ['#14'],
    rule: '人物与场景互动的物理真实感是质检红线：重力、破碎、碰撞假了，整片就假',
    action: '有互动时检查重力、材质破碎与接触阴影的合理性' },
  { id: 'P4', scope: 'all', evidence: ['#20'],
    rule: '人体动作要干净利落，不要生硬拖沓（AI 生成的通病）',
    action: '舞蹈与表演段落的动作设计要简洁有力，减少黏连过渡帧' },
  { id: 'P5', scope: 'all', evidence: ['#20'],
    rule: '慢动作是调料不是主菜，用多了就假',
    action: '慢动作只留给情绪峰值点，全片不超过 2–3 处' },
  // 二、选角与群像
  { id: 'P6', scope: ['hiphop-mv'], evidence: ['#9', '#68'],
    rule: 'Hiphop MV 默认多人（95% 法则）：文化从 hood 起来，不是一个主角演完的',
    action: '未指定单人时自动加入群像（crew、街坊、舞者），群像要有主次、C 位明确' },
  { id: 'P7', scope: ['ugc-commerce'], evidence: ['#8', '#46'],
    rule: '非商业种草视频，单人全程是禁忌，背景要有烟火气',
    action: '博主风格需求时，背景加入路人、店员、宠物等生活气息，哪怕不出声' },
  { id: 'P8', scope: ['music-mv', 'product-ad'], evidence: ['#11'],
    rule: '仪式感需要诚服者：大场面靠一群朝拜的人撑，单人独走撑不住',
    action: '史诗与仪式场景加入群像朝拜构图' },
  // 三、商业广告公式
  { id: 'P9', scope: ['product-ad'], evidence: ['#3', '#16', '#26', '#37', '#42', '#45'],
    rule: '大牌美妆商拍公式：极端产品微距 + 慢动作 → 人物肩上近景 + 慢动作 → 全程无对白只有产品 ASMR 与 BGM → 结尾产品回归主角',
    action: '商拍需求按这四步推进；该公式可迁移到高跟鞋、耳机、太阳镜、手包等配饰' },
  { id: 'P10', scope: ['product-ad'], evidence: ['#3'],
    rule: '相似性转场：找一个长得像产品的真实场景或物体交叉剪进去（腮红盘的闪粉像沙盘 → 真实沙漠）',
    action: '产品特写段落寻找视觉相似的自然或现实意象做转场' },
  { id: 'P11', scope: ['product-ad', 'music-mv'], evidence: ['#5'],
    rule: '商业广告有真人出演时，结尾需要一句 flag 台词点题，缺了就显空旷',
    action: '检测到「商业 + 真人出演」时，结尾加入落在产品主张上的点题台词或旁白' },
  { id: 'P12', scope: ['product-ad', 'ugc-commerce'], evidence: ['#2'],
    rule: 'ASMR 是声音卖点产品的杀手锏（键盘轴体声、耳机音质、拉链、按键、泵压）',
    action: '卖点含声音时走 ASMR 式微距加现场收音，不压 BGM' },
  { id: 'P13', scope: ['product-ad', 'music-mv'], evidence: ['#11'],
    rule: '产品线和故事感是品牌大片的必需品：光有美学场面撑不起来',
    action: '香水与高时尚品牌大片要有产品出现逻辑和叙事线' },
  // 四、科普与叙事公式
  { id: 'P14', scope: ['explainer'], evidence: ['#7'],
    rule: '有历史的行业用古今对比引入（麻醉、中医、酿酒、手工）',
    action: '先拍古代工作场景与工具特写，再硬切现代，用强烈对比引出现状' },
  { id: 'P15', scope: ['explainer'], evidence: ['#12', '#19'],
    rule: '儿童科普两条路：手工温度（黏土的笨拙感）或故事化（拟人主角的旅程）',
    action: '儿童科普需求时二选一或融合，不要两头都不靠' },
  { id: 'P16', scope: ['explainer'], evidence: ['#19', '#50'],
    rule: '抽象概念要拟人化成有旅程的主角（水循环 → 水滴坐蒸发列车；复利 → 硬币戴红围巾站雪坡）',
    action: '抽象主题赋予具体角色、道具和旅程，不停留在图表' },
  // 五、运镜与剪辑
  { id: 'P17', scope: 'all', evidence: ['#11', '#13'],
    rule: '运镜太少等于人物太死：全是正面侧面全身半身，人就僵',
    action: '单场景停留超过 5 秒且无运镜变化时，加入推拉、环绕或角度切换' },
  { id: 'P18', scope: ['hiphop-mv'], evidence: ['#9', '#57', '#62'],
    rule: 'Hiphop 运镜手法库：鱼眼、从头顶斜视、从脚部斜上拍、低角度仰拍',
    action: '嘻哈需求默认可调用这四种运镜，#57 滑板鱼眼与 #62 街头鱼眼是完整示范' },
  { id: 'P19', scope: 'all', evidence: ['saga 案例'],
    rule: '场景转换要有呼吸感，不要节拍器式剪辑',
    action: '剪辑点对准音乐重拍或乐句结尾，但镜头时长要有快有慢（1.5s 闪切与 3s 停留交替）' },
  { id: 'P20', scope: 'all', evidence: ['saga 案例'],
    rule: '角色连续性是高级技法：同一身份走过多个场景，步伐连续，背景硬切',
    action: '多场景穿越需求时保持角色身份与动作连续，只切背景，位置渐进，结尾转身 reveal' },
  // 六、风格判断
  { id: 'P21', scope: 'all', evidence: ['#20'],
    rule: '看脸不看氛围：人物种族与面孔特征是风格判断的硬指标',
    action: '不按氛围把欧美面孔归成韩系或华语风' },
  { id: 'P22', scope: ['ugc-commerce', 'product-ad'], evidence: ['#1', '#3'],
    rule: '博主感 vs 商业感是第一分类轴：同样是美妆，两者完全两极',
    action: '美妆与产品需求先确认是博主种草还是品牌广告，再决定注入哪一套' },
  { id: 'P23', scope: ['hiphop-mv', 'music-mv'], evidence: ['#4', '#62'],
    rule: '真嘻哈等于街头真实，禁科幻霓虹（#62 原话：不要使用科幻、赛博朋克、霓虹未来城市或夸张 AI 特效）',
    action: '嘻哈需求默认走街头真实路线，除非用户明确要赛博或未来；解除后仍按 #4 做反面检查' },
  { id: 'P24', scope: ['music-mv', 'explainer'], evidence: ['#12', '#15', '#36', '#48', '#55', '#66'],
    rule: '动画风格先定路数：动画 MV 不是一种风格',
    action: '动画需求必须细化到日系赛璐璐 / 厚涂霓虹 / 酸性实验 / 黏土 / 乐高 / 拼贴之一' },
  // 七、奇观揭示（条件触发的技法）
  { id: 'P25', scope: ['music-mv', 'hiphop-mv', 'product-ad', 'explainer'], evidence: ['YouTube Shorts p3tB_YSHG_0'],
    triggers: ['烟花', '焰火', '爆炸', '爆点', '穿越机', 'fpv', '无人机穿越', '穿进', '飞进', '内部视角', '奇观', '揭示', '真身', '不可能视角', 'through the explosion'],
    rule: '穿越机穿爆点：用不可能视角揭示物体的 3D 真身。从地面看烟花是扁的 2D 圆，从内部看是立体的火星球，有纵深有体积；穿过爆炸瞬间的整屏白爆天然就是转场点',
    action: '需要奇观揭示时用 FPV 内部视角（prompt 关键词：FPV drone flying through explosion interior, volumetric 3D）。适用：副歌高潮对鼓点、转场、任何观众以为自己见过但其实没见过真身的物体' },
  // 八、来自导演模式与 VIBES 的三条（App 导演模式面板的硬编码约束，2026-06 做的，
  // 面板本身没有入口；这里只保留它判断正确的那几条，模板化的导演分析不要）
  { id: 'P26', scope: 'all', evidence: ['导演模式 MV 载荷', '#68'],
    triggers: ['多主角', '两个人', '三个人', '三人', '群像', '多角色', '角色卡槽', '双人'],
    rule: '多主角参考图不得串脸：每个角色绑定自己的参考图，特征不能互换',
    action: '多角色时提示词里逐个点名角色与其参考图，明确禁止长相、服装、配饰在角色之间漂移；群像仍要 C 位明确' },
  { id: 'P27', scope: 'all', evidence: ['导演模式 MV 载荷'],
    rule: '用户写的禁止项是硬约束（禁止误读必须遵守）：他说不要拍成什么，就绝对不能出现',
    action: '把用户的禁止项原样写进负面提示词，并置于风格 DNA 的建议之上；两者冲突时以用户的为准' },
  { id: 'P28', scope: ['music-mv', 'hiphop-mv'], evidence: ['VIBES 证据层设计 2026-06-01'],
    rule: '音频分析是证据层，用户的情绪判决优先于 BPM、调性和能量曲线',
    action: '有音频数据时用它对齐剪辑点与段落，但情绪、色调和镜头语言仍按用户写的情绪判决走；两者冲突时听用户' },
];

/** Principles that wait for their own cue (Principle.triggers). */
export const CONDITIONAL_PRINCIPLES: readonly Principle[] = STYLE_PRINCIPLES.filter((principle) => (principle.triggers?.length ?? 0) > 0);

/** Positive and negative worked examples, used as the post-generation self-check. */
export const QUALITY_ANCHORS = {
  positive: {
    id: '#68',
    label: 'Blood Shadow Fury（Lisa "Rockstar" 式暗黑 K-pop 女团嘻哈）',
    lessons: [
      '文化符号精准：一个定调道具就够（白色能剧面具），不堆砌',
      '空间有权力感：场景本身在讲故事（深红与黑王座大厅）',
      'C 位明确：群像但有主次，舞者环绕主角',
      '色调有纪律：主色不超过 2 个',
    ],
    checks: ['有没有一个定调道具？', '场景在讲故事还是纯背景板？', '群像有主次吗？', '主色是否不超过 2 个？'],
  },
  negative: {
    id: '#4',
    label: 'MANIAC: Urban Neon（伪未来男团，用户原话「很差的 MV」）',
    lessons: [
      '造型与场景各说各话：元素拼贴但无融合，这是 AI 生成最常见的失败',
      '生成场景经不起暂停细看',
      '场景与音乐情绪脱节',
      '运镜太平，人物像站在绿幕前',
      '人物不与场景互动，场景是纯背景板',
    ],
    checks: ['造型和场景在对话吗？', '暂停一帧场景经得起看吗？', '运镜至少 3 种变化吗？', '人物碰到场景了吗（至少 1 处互动）？', '场景和音乐情绪对得上吗？'],
  },
} as const;

/** Rules that outrank a single style's DNA, per category. */
export const CATEGORY_DEFAULTS: Readonly<Record<StyleCategory, readonly PrincipleId[]>> = {
  'hiphop-mv': ['P6', 'P18', 'P23', 'P4', 'P5', 'P17'],
  'music-mv': ['P4', 'P5', 'P17', 'P19', 'P21', 'P24'],
  'product-ad': ['P9', 'P10', 'P11', 'P13', 'P22'],
  'ugc-commerce': ['P7', 'P12', 'P22'],
  explainer: ['P14', 'P15', 'P16', 'P24'],
};

const HIPHOP: readonly StyleDna[] = [
  { id: 'hh-real-street', category: 'hiphop-mv', label: '真实街头嘻哈 Real Street Hip-hop', quality: 'verified',
    triggers: ['真实街头', '街头写实', '滑板', '鱼眼', '黑白街拍', '90s', 'raw', 'hood', 'crew', '不要 AI 感', '不要特效', 'real street'],
    motifs: ['街角、人行道、台阶、夜晚街道', '滑板与板仔', '街头时尚造型', 'crew 群像与路人'],
    palette: '黑白或粗粝质感，夜街以路灯等真实光源为主，真实质感优先于精致调色',
    camera: ['鱼眼贴近 crew', '从头顶斜视拍围圈', '从脚部斜上拍群体 walk', '低角度仰拍'],
    pacing: '剪辑点对准重拍与乐句结尾，1.5s 闪切与 3s 停留交替，不要节拍器式',
    antiPatterns: ['科幻、赛博朋克、霓虹未来城市、夸张 AI 特效', '单人全程', '过度精修美颜与光滑商业质感', '拖沓粘连的 AI 式动作'],
    principles: ['P6', 'P18', 'P23', 'P4', 'P5', 'P17', 'P19'], evidence: ['#25', '#57', '#62'] },
  { id: 'hh-kpop', category: 'hiphop-mv', label: '暗黑 K-pop 女团嘻哈 K-pop Hiphop', quality: 'anchor-positive',
    triggers: ['Lisa', 'BLACKPINK', 'K-pop', '编舞', '曼谷', '唐人街', '泰国', 'girl crush', 'idol', '暗黑女团', '能剧面具', '王座', '仪式感', 'sawadika'],
    motifs: ['定调道具（如白色能剧面具）', '王座大厅等讲故事的空间', '舞者环绕、C 位居中', '霓虹招牌与街头小摊（明亮变体）'],
    palette: '暗黑变体用深红加黑贯穿，主色不超过 2 个；明亮变体用高饱和霓虹红金翠绿，湿润反光',
    camera: ['广角街景与摇臂升降', 'Steadicam 跟整段编舞', '近景与全景交替', 'MV 式倾斜构图'],
    pacing: '切点对准编舞重拍，副歌全身舞蹈加整齐队形，每 1–2 拍一次视觉更新',
    antiPatterns: ['廉价未来科技贴皮（#4 式）', '霓虹杂色、无色调纪律', '刻板异国符号堆砌', '即兴凌乱的舞蹈'],
    principles: ['P6', 'P4', 'P5', 'P17', 'P23'], evidence: ['#68'] },
  { id: 'hh-fashion-psych', category: 'hiphop-mv', label: '时尚迷幻嘻哈 Fashion-Psychedelic', quality: 'mediocre',
    triggers: ['ASAP Rocky', 'Playboi Carti', '杂志大片', '高定', '致幻', '梦游', '迷幻时尚', 'cloud rap', '数字幻觉', '故障拼贴', '荧光波普'],
    motifs: ['高定与街头混搭、模特群像', '超现实便利店、故障艺术拼贴', '镜面与反光材质', '慢行漫游的人物'],
    palette: '糖果色与酸性色并置，粉青紫荧光黄，高光泛光、阴影偏紫；迷幻色只叠在局部',
    camera: ['鱼眼与超广角', '缓慢推拉', '双重曝光、镜像、色散拖影'],
    pacing: '偏慢，吃拍点之间的呼吸，副歌切换造型，每套停留 2–4 秒',
    antiPatterns: ['现实场景没质感就上迷幻', '全屏迷幻覆盖', '单人特写加迷幻', '赛博朋克与霓虹未来城市'],
    principles: ['P1', 'P2', 'P6', 'P18', 'P23'], evidence: ['#9'] },
  { id: 'hh-east-coast', category: 'hiphop-mv', label: '纽约硬核 East Coast Gritty', quality: 'verified',
    triggers: ['纽约', '90年代', 'boom bap', 'grimy', 'Wu-Tang', 'Nas', 'Biggie', 'Mobb Deep', 'projects', '冬天', '街角'],
    motifs: ['公屋楼群、楼梯间、地铁站、屋顶', 'Timberland 靴与羽绒服', '油桶火堆与烟雾', 'crew 围圈 cipher'],
    palette: '低饱和偏冷灰蓝，棕黑泥土色，高对比粗颗粒胶片，路灯橙钠光点缀',
    camera: ['广角低角度仰拍显气势', '近距离脸部特写', '手持纪实感', '屋顶全景城市天际线'],
    pacing: '跟 85–95 BPM 的 boom bap，每镜 2–4 秒，在 snare 上切',
    antiPatterns: ['加州阳光与棕榈树', '霓虹夜店与荧光滤镜', '无人机航拍', '过度美颜', '科幻赛博贴皮'],
    principles: ['P6', 'P18', 'P23'], evidence: ['#62'] },
  { id: 'hh-trap', category: 'hiphop-mv', label: 'Trap（现代亚特兰大）', quality: 'verified',
    triggers: ['Trap', 'Atlanta', 'Migos', 'Future', 'Travis', 'Gucci Mane', 'Lambo', '珠宝', 'trap house', 'lean', 'flex', '炫富'],
    motifs: ['designer 服与全钻饰品', '豪车、大宅、泳池', 'Trap house 与厨房', '现金墙与 bandz'],
    palette: '高对比冷暗背景加亮色点缀，紫红、霓虹蓝、黄金色，霓虹蓝必须来自夜店灯与车灯等真实光源',
    camera: ['超广角鱼眼低角度', '手持晃动跟随', 'Steadicam 绕拍', '对称摆拍'],
    pacing: '130–160 BPM，hi-hat roll 时闪切，每镜 0.5–2 秒，drop 用镜头震动与 speed ramp',
    antiPatterns: ['老派 boombox 与复古 VHS', '东岸 cipher', '科幻赛博与霓虹未来城市贴皮', '滥用慢动作'],
    principles: ['P5', 'P18', 'P23', 'P4'], evidence: [] },
  { id: 'hh-drill', category: 'hiphop-mv', label: 'Drill（芝加哥 / UK / NY）', quality: 'verified',
    triggers: ['Drill', 'Chief Keef', 'Pop Smoke', 'Headie One', 'balaclava', '面罩', '街区', 'sliding', '冷酷', '压迫'],
    motifs: ['黑色面罩与羽绒服', '街角、公屋走廊、停车场、雨夜', 'crew 围圈与群体 walk', '帮派手势'],
    palette: '低饱和冷灰蓝，暗沉夜景加路灯橙黄，极暗部压黑',
    camera: ['低角度广角贴近群体', '对镜凝视', '鱼眼贴近 crew', '从脚部斜上拍群体 walk'],
    pacing: '140 BPM 左右，切在 kick 与 bass slide，副歌群体 walk 时快切',
    antiPatterns: ['阳光沙滩与豪华派对', '彩虹霓虹与华丽 CGI', '科幻赛博贴皮', '拖沓的 slide 动作'],
    principles: ['P6', 'P18', 'P23', 'P4'], evidence: [] },
  { id: 'hh-conscious', category: 'hiphop-mv', label: 'Conscious / Art-Rap（Kendrick 系）', quality: 'verified',
    triggers: ['Kendrick', 'Compton', '有隐喻', '有深意', '社会议题', '宗教感', '电影级概念', '象征符号', '觉醒'],
    motifs: ['警车车顶与路灯杆', '最后的晚餐式长桌构图', '教士白袍与失重飞行', '街坊群众演员'],
    palette: '高反差黑白，或饱和暖黄橙正红，画面干净不加复古滤镜',
    camera: ['严格对称中心构图', '广角与鱼眼', '低机位仰拍与正顶俯拍', '长镜头缓推'],
    pacing: '按乐句与歌词段落切，寓言段落为单位，节拍切换处硬切或静帧',
    antiPatterns: ['金链香槟豪车炫富', '空洞夜店频闪', '无意义特效转场', '美颜磨皮'],
    principles: ['P23', 'P17'], evidence: [] },
  { id: 'hh-melodic', category: 'hiphop-mv', label: 'Melodic / Emo Rap（Travis Scott 系）', quality: 'verified',
    triggers: ['Travis Scott', 'Astroworld', '游乐场', '迷幻', '暗黑派对', 'auto-tune', 'rage', 'moshpit', '演唱会感'],
    motifs: ['游乐园废墟与巨型头像入口', '旋转房间与倒立人物', '火焰与烟雾', '人群冲撞跳跃'],
    palette: '沙漠橙与深紫、焦糖黄、近黑阴影，强对比带颗粒雾感',
    camera: ['鱼眼贴脸', '翻转与旋转镜头', '低机位手持冲撞', '从头顶斜视拍 mosh pit'],
    pacing: '随 beat switch 换视觉世界，快切与慢动作交替，drop 处全场爆发',
    antiPatterns: ['清爽明亮日光', '干净对称美术构图', '老派胶片写实', '科幻赛博贴皮', '慢动作泛滥'],
    principles: ['P5', 'P18', 'P23', 'P4'], evidence: [] },
  { id: 'hh-boom-bap-revival', category: 'hiphop-mv', label: 'Boom-Bap Revival（Griselda / Joey 系）', quality: 'verified',
    triggers: ['Griselda', 'Westside Gunn', 'Conway', 'Joey Bada$$', '胶片感', '老派', 'boom-bap', 'cypher', '怀旧', '粗粝'],
    motifs: ['布鲁克林街区与台阶', '连帽衫工装靴', '黑胶与随身听', '街边群像与 cypher'],
    palette: '低饱和偏暖灰褐与墨绿，黑位抬起，16mm 颗粒与轻微漏光',
    camera: ['手持纪录片式', '中景与特写为主', '标准镜头稳定站位', '对镜直接说唱'],
    pacing: '切点跟 snare，中速稳定，长镜头让口技完整呈现，段落间硬切',
    antiPatterns: ['无人机大航拍', '糖果色与重度 CG', 'auto-tune 式光滑视觉', '科幻赛博贴皮'],
    principles: ['P6', 'P23'], evidence: ['#67'] },
  { id: 'hh-old-school', category: 'hiphop-mv', label: 'Old School（80s 街区派对）', quality: 'verified',
    triggers: ['老派', '80年代', 'block party', 'boombox', 'Run-D.M.C.', 'Adidas', 'scratch', 'breakdance', 'Bronx'],
    motifs: ['boombox 与转盘', '纸板 breakdance 地垫', '涂鸦墙与地铁车厢', 'MC 与 DJ 同框'],
    palette: '80s 录像带质感，饱和但偏脏的原色，NTSC 拖影与轻微色渗',
    camera: ['固定机位中景与全身', 'MC 正面对镜头念词', '手持跟拍街区', '偶有快速推拉变焦'],
    pacing: '每镜 2–5 秒，多在小节换段处切，表演长镜头为主',
    antiPatterns: ['豪车游艇炫富与钞票雨', '无人机与高速 whip-pan', '冷青橙调色', '过度 CGI 与 glitch'],
    principles: ['P6'], evidence: [] },
  { id: 'hh-west-coast', category: 'hiphop-mv', label: 'West Coast G-funk', quality: 'verified',
    triggers: ['加州', 'Compton', 'Dre', 'Snoop', 'lowrider', 'G-funk', '夕阳', 'BBQ', '慵懒', 'cruising', 'West Coast'],
    motifs: ['Lowrider 低底盘车液压跳跃', '后院烧烤派对', '棕榈树与长滩街区', '女郎与家庭同乐'],
    palette: '暖金色黄昏偏琥珀，天空蓝紫渐变，高光柔和带光晕，慵懒日落感',
    camera: ['稳定低机位平移', '慢速 Steadicam 跟拍', '广角拍车队、长焦拍棕榈逆光'],
    pacing: '90–100 BPM 慢摇，每镜 3–5 秒，溶接与长镜头，高潮在副歌派对群像',
    antiPatterns: ['冬天雪景与东岸地铁', '过度冷蓝调与快速闪切', '暗黑压抑地下室', '现代 trap 珠宝特写'],
    principles: ['P6'], evidence: [] },
  { id: 'hh-dirty-south', category: 'hiphop-mv', label: 'Dirty South（亚特兰大 / 休斯顿）', quality: 'verified',
    triggers: ['南部', 'Houston', 'Atlanta', 'OutKast', 'slab', 'grillz', 'crunk', 'candy paint', 'chopped and screwed', '慢摇'],
    motifs: ['Slab 车与 candy paint', '金牙与大号链坠', '南部教堂与后院', '鲜艳套装与 pimp 风'],
    palette: '高饱和 candy 色（紫、糖果绿、亮橙），南部强烈日光，夜景用霓虹与车灯',
    camera: ['广角低机位拍车', '车轮特写与慢速环绕', '摇臂拉升拍街区聚会', '鱼眼拍 hype 群众'],
    pacing: 'crunk 时强烈 stomp 切，chopped & screwed 时用慢动作与长镜，hook 处重复镜头',
    antiPatterns: ['东岸灰暗冬景', '极简黑白艺术风', '芝加哥 drill 面具', '无表情冷淡 mugging'],
    principles: ['P6', 'P5'], evidence: [] },
];

const MUSIC_MV: readonly StyleDna[] = [
  { id: 'mv-kpop-choreo', category: 'music-mv', label: 'K-pop 编舞 MV', quality: 'verified',
    triggers: ['BLACKPINK', 'BTS', 'aespa', '刀群舞', '齐舞', '团体编舞', '偶像团体', '颜值特写', 'girl crush', '韩团', '打歌 MV'],
    motifs: ['超大型概念布景，一支 MV 8–15 个场景', '全员刀群舞，C 位居中偏上', '每位成员至少一个单人特写', '招牌 point choreo 正面清晰'],
    palette: '每个场景只用一个主色，场景间色彩对撞，高饱和但肤色单独保护',
    camera: ['编舞段正面中远景加 0.3–0.5 秒快速推拉卡重拍', 'whip pan 与旋转转场', '高机位俯拍队形', '360° 环绕'],
    pacing: 'BPM 100–140，平均镜长 0.8–1.5 秒，副歌可到 0.4–0.6；drop 前插静帧或黑场停顿',
    antiPatterns: ['手持晃动纪实与粗颗粒胶片', '只拍一个人一个场景到底', '舞蹈用侧面背面拍导致队形不可辨', '低饱和灰暗脏乱街景'],
    principles: ['P4', 'P5', 'P17', 'P21'], evidence: ['#68'] },
  { id: 'mv-edm-festival', category: 'music-mv', label: 'EDM 电音节视觉化', quality: 'verified',
    triggers: ['电音节', '音乐节现场', 'drop 炸开', '激光', '烟雾', '万人举手', 'Tomorrowland', 'Ultra', 'Avicii', 'EDM', 'house', 'dubstep', 'visualizer'],
    motifs: ['DJ 台剪影与万人人海', 'CO₂ 喷射与烟火', '激光阵列穿过烟雾', '巨型 LED 墙与纸屑炮'],
    palette: '电光青、品红、激光绿、UV 紫、冷白频闪，极高饱和，深黑背景加发光光束',
    camera: ['FPV 无人机穿越人群直扑主舞台', '超广角舞台全景', 'DJ 背后过肩机位', '长焦压缩人群'],
    pacing: 'build-up 随 snare roll 加速（每 4 拍 → 每 1/2 拍），drop 第一拍同时触发喷射、白闪与最大全景',
    antiPatterns: ['乐手弹真实乐器作为主体', '白天平光无烟雾的室内', '安静情绪叙事与长特写', 'drop 处画面不爆发'],
    principles: ['P5', 'P17', 'P19', 'P25'], evidence: ['#13'] },
  { id: 'mv-rock-band', category: 'music-mv', label: '摇滚乐队演出 MV', quality: 'verified',
    triggers: ['乐队演出', '吉他 solo', '鼓手打鼓', 'live house', '汗水', '嘶吼', 'Nirvana', 'Foo Fighters', 'Linkin Park', '朋克', '车库'],
    motifs: ['全员乐器同框如舞台站位', '鼓槌砸镲片与汗水飞溅', '主唱对麦嘶吼', '观众冲撞与 mosh pit'],
    palette: '钨丝灯暖橙与脏黄、冷青阴影、纯黑，低到中饱和，肤色粗粝不美化，16mm 颗粒与漏光',
    camera: ['手持贴近乐手，允许晃动失焦', '低角度仰拍主唱与吉他手', '广角贴脸产生透视变形', '鼓后视角与一镜穿梭'],
    pacing: '按乐器轮流点名（riff 切吉他、fill 切鼓、人声切主唱），主歌 ASL 2–3 秒，副歌 0.5–1 秒',
    antiPatterns: ['偶像舞台式编舞与定点走位（no idol-stage choreography）', '光洁美颜与柔光正面打亮', '乐器摆着没人演奏或指法不对', '高饱和霓虹粉与糖果色'],
    principles: ['P4', 'P17'], evidence: ['#27'] },
  { id: 'mv-nocturnal-rnb', category: 'music-mv', label: 'R&B 慢奢华 Cinematic Nocturnal R&B', quality: 'verified',
    triggers: ['The Weeknd', '霓虹夜', '城市夜景', '一个人开车', '电影感', '孤独', '颓废', '复古跑车', '拉斯维加斯', 'synthwave', '亡命驾驶'],
    motifs: ['夜间都市驾驶与掠过的路灯光带', '孤独主角独行', '湿柏油路面的霓虹倒影', '奢华室内与烟酒暗红光'],
    palette: '霓虹红、深酒红、品红紫、钴蓝青、钠灯橙，暗部深青黑；饱和只集中在光源上',
    camera: ['慢速推轨，每镜 4–8 秒', '车内机位拍司机', '对称走廊一点透视长镜', '透过虚化霓虹光斑拍人'],
    pacing: '平均镜长 3–6 秒，在小节线或乐句开头切，跟人声与 pad 而不是跟鼓，转折处硬切黑场',
    antiPatterns: ['白天阳光户外为主体', '快速卡点剪辑（ASL 低于 1 秒）', '群体派对与欢乐大笑', '糖果色与低对比柔和调色'],
    principles: ['P5', 'P17', 'P19'], evidence: [] },
  { id: 'mv-latin-reggaeton', category: 'music-mv', label: '拉丁雷鬼顿 Latin Reggaeton', quality: 'verified',
    triggers: ['Bad Bunny', 'J Balvin', 'Daddy Yankee', '拉丁', '雷鬼顿', 'reggaeton', 'perreo', '热带', '海滩', '街头派对', 'Despacito'],
    motifs: ['街区派对与屋顶院子', '加勒比彩色建筑外墙', 'Perreo 群舞围绕主唱', '改装车与摩托车队'],
    palette: '热带暖色，芒果橙、热粉、柠檬黄、加勒比蓝绿，极高饱和，汗光视为性感',
    camera: ['低角度仰拍舞者', '手持在人群中环绕主唱', '鱼眼贴近艺人脸部', '无人机俯拍彩色屋顶'],
    pacing: 'BPM 88–100，跟 dembow 律动在 boom 上切镜，平均镜长 1–2 秒，重拍加镜头抖动',
    antiPatterns: ['冷色调低饱和灰暗城市', '孤独忧郁内省', '军队式刀群舞队形', '北方都市与冬季雪景'],
    principles: ['P17', 'P19'], evidence: [] },
  { id: 'mv-mandopop-ballad', category: 'music-mv', label: '华语抒情 MV Mandopop Ballad', quality: 'verified',
    triggers: ['周杰伦', '林俊杰', '五月天', '晴天', '小幸运', 'KTV', '校园', '单车', '雨', '车站', '那些年', '青春电影', '走心', '遗憾'],
    motifs: ['校园教室走廊与白衬衫校服', '雨与伞、雨滴打在车窗', '歌手独唱镜头与钢琴侧影', '信物小物件与擦肩而过'],
    palette: '回忆线暖黄奶白与日系柔光，现实线冷灰蓝低饱和，夕阳金橙用于情绪高点',
    camera: ['双线叙事交叉剪辑', '逆光侧脸特写', '缓慢横移沿走廊街道', '焦点转移象征回忆与现实'],
    pacing: '平均镜长 3–6 秒，跟歌词与情绪而不是鼓点，桥段到最后一次副歌是剧情转折',
    antiPatterns: ['剧情过满拍成三幕剧，对白盖过副歌', '欧美式快剪卡点与速度渐变', '高饱和撞色霓虹', '歌手全程正脸对嘴', '金句字幕轰炸', '塑料感美颜滤镜'],
    principles: ['P5', 'P19', 'P21'], evidence: [] },
  { id: 'mv-indie-lofi', category: 'music-mv', label: '独立 lo-fi 卧室流行', quality: 'verified',
    triggers: ['卧室里随手拍', 'Clairo', 'Pretty Girl', 'VHS', 'DV', '胶片质感', '日期戳', '复古慵懒', '松弛感', 'bedroom pop', 'lo-fi', '手机拍', '滑板'],
    motifs: ['卧室即舞台，真的有人住的样子', '低像素设备本身入画（取景框、时间码）', '少年日常小事，无聊本身就是内容', '朋友群像直接出镜'],
    palette: '褪色低对比轻微过曝偏暖，黑位提起，VHS 偏色与色彩溢出',
    camera: ['4:3 画幅模拟 VHS 或 DV', '固定自拍机位，人物可走出画面', '手持晃动与对焦失败保留', '数码变焦而非推轨'],
    pacing: '单镜 5–15 秒，不卡点甚至故意错开，跳切推进，情绪平直无高潮爆发',
    antiPatterns: ['4K 电影机加专业布光再套 VHS 滤镜（精致假业余）', '专业舞蹈编排', '强叙事与戏剧冲突', '高饱和霓虹', '网红样板间卧室'],
    principles: ['P19'], evidence: ['#60'] },
  { id: 'mv-hyperpop-glitch', category: 'music-mv', label: 'Hyperpop / Glitchcore', quality: 'verified',
    triggers: ['100 gecs', 'Charli XCX', 'SOPHIE', 'Y2K', '千禧年', 'Windows 98', '故障风', '数据损坏', 'RGB 错位', '芭比粉', '镭射', 'hyperpop', 'glitchcore'],
    motifs: ['Y2K 操作系统界面与报错弹窗', '早期网页装饰与像素字体', '3D 光滑液态金属与充气塑料', '数字身体变形'],
    palette: '超饱和撞色（芭比粉、电光蓝、荧光绿、柠檬黄、电紫），镭射全息渐变，RGB 通道错位',
    camera: ['混合媒介多层叠加', '绿幕故意抠不干净', '鱼眼极端广角贴脸', '3D 里不可能的虚拟运镜'],
    pacing: '平均镜长 0.2–1 秒，与音乐故障同步，卡帧重复，极乱之后突然切静',
    antiPatterns: ['莫兰迪色与高级灰的克制美学', '故障只当滤镜套全片', '写实叙事', '赛博朋克暗黑工业', '全片统一精致画质'],
    principles: ['P19'], evidence: ['#48'] },
  { id: 'mv-animation', category: 'music-mv', label: '动画 MV（必须先定路数）', quality: 'verified',
    triggers: ['动画', '动漫', '二次元', '卡通', '定格', '黏土', '乐高', '拼贴', '毛毡', '赛璐璐', '厚涂', '酸性动画'],
    routes: ['日系 2D 赛璐璐 lofi（#15，city pop / future pop 首选）', '厚涂霓虹（#55，时尚驱动，超短）', '酸性实验动画（#48，高饱和波普加故障 RGB）', '黏土定格（#12 科普 / #25 治愈）', '乐高定格（#36）', '拼贴定格（#66）与毛毡（#34）'],
    motifs: ['路数决定母题：娃娃屋剖面、厚涂笔触体积感、波普图形阵列，或材质本身的指纹与绒毛'],
    palette: '跟路数走：lofi 暖调低饱和、暗底霓虹高光、高饱和互补撞色，或材质本色',
    camera: ['赛璐璐走一镜到底式空间叙事', '厚涂走时装大片定格亮相', '酸性走故障转场与图形冲击', '定格走固定机位微缩俯拍'],
    pacing: '赛璐璐匀速不抢拍，厚涂 20 秒一击即中，酸性高频剪切跟鼓点，定格靠低帧率顿挫',
    antiPatterns: ['只写「动画风格」不定路数', '路数混搭失控（赛璐璐平涂叠厚涂笔触）', '定格做得过于丝滑丢失手工感', '酸性动画不写负面提示词'],
    principles: ['P24', 'P4', 'P5'], evidence: ['#12', '#15', '#25', '#34', '#36', '#48', '#55', '#66'] },
  { id: 'mv-surreal-fashion', category: 'music-mv', label: '超现实时装概念 MV', quality: 'verified',
    triggers: ['时装大片', '香水', '高定', '品牌概念片', '神性', '史诗', '异星', '女祭司', '液态金属', '机甲', '未来感'],
    motifs: ['银发祭司与液态金属机甲', '仪式性站位与神殿式空间', '贴身金属材质与彩虹反射', '群像朝拜撑起神性'],
    palette: '冷银、珍珠白、月光灰为主，液态金属高光是唯一亮点色；赛博路用冷金属底配彩虹色散',
    camera: ['三幕 22 镜，镜头类型随剧作推进', '推拉、环绕、仰拍神性构图', '实拍加 CGI 混合，反射要长在人物身上'],
    pacing: '降临现身 → 对峙变形 → 神性回响，转场卡乐句但时长有快有慢，慢动作只留神性显现',
    antiPatterns: ['纯美学堆砌没有幕次结构', '全屏 CGI 覆盖的绿幕感', '运镜太少人物太死', '缺产品线与故事感', '物理失真（液态金属没重量、接触无阴影）'],
    principles: ['P1', 'P2', 'P3', 'P8', 'P13', 'P17', 'P5'], evidence: ['#11', '#13', '#38'] },
  { id: 'mv-retro-era', category: 'music-mv', label: '复古年代 MV（先定年代）', quality: 'verified',
    triggers: ['复古', '怀旧', '60s', '70s', 'Y2K', '千禧', '法式', '胶片', '宝丽来', '公路', '田园'],
    routes: ['1960s 法式室内甜美（#39）', '法式乡村黄金时刻（#56）', '1970s 友情公路（#43）', 'Y2K 平面图形拼贴（#32）', 'Y2K 衣帽间优雅（#58）'],
    motifs: ['粉色房间与复古家具造型', '红裙苹果园与逆光草地', '三人同行与 T2 巴士日落', '放射状图形与宝丽来照片墙'],
    palette: '一条路数锁定一种年代色板，不跨年代混调',
    camera: ['室内走人物中近景承载 lip-sync', '户外走黄金时刻逆光跟随', '公路片稳定克制、记录感优先', '衣帽间平稳横移加细节特写'],
    pacing: '跟各自年代的音乐走，剪辑点对准音乐结构但时长有变化',
    antiPatterns: ['年代元素穿越混搭', '年代只贴滤镜皮而场景服装道具不对位', '公路友情片缩成单人独演', '表情夸张过度表演', '无意义环绕、机械平移、突然变焦、剧烈抖动'],
    principles: ['P5', 'P19'], evidence: ['#32', '#39', '#43', '#56', '#58'] },
];

const PRODUCT_AD: readonly StyleDna[] = [
  { id: 'ad-cosmetics', category: 'product-ad', label: '美妆广告 Cosmetics Commercial', quality: 'verified',
    triggers: ['面霜', '精华', '粉底', '口红', '眼影', '防晒', '面膜', '质地', '上脸', '功效', '试色', '大牌', '商拍', '高级感', '无对白'],
    motifs: ['质地特写：乳霜涡旋、精华液滴、粉末飞散、膏体旋出', '皮肤 glow 与毛孔级特写', '极端产品微距，多角度多位置', '相似性意象（闪粉像沙盘 → 真实沙漠）'],
    palette: '护肤偏柔和中性（奶白、裸粉、浅金），彩妆以产品色为主角，beauty lighting 大面积柔光',
    camera: ['大量 macro 与极特写', '85–135mm 长焦压缩面部', '120fps 以上拍液体与粉末', '人物肩上近景加慢动作'],
    pacing: 'Problem–Product–Proof 三幕，或 P9 四步：极端微距 → 肩上近景 → 全程无对白只有 ASMR 与 BGM → 产品回归主角推镜',
    antiPatterns: ['厚重阴影与暗调恐怖感', '过度磨皮至塑料感', '遮挡产品或包装难辨', '商拍变体里加对白或口播', '有人出演却缺结尾点题'],
    principles: ['P9', 'P10', 'P11', 'P12', 'P22'], evidence: ['#3', '#16', '#26', '#37', '#42', '#45'] },
  { id: 'ad-luxury-product', category: 'product-ad', label: '奢侈品产品大片 Luxury Product Film', quality: 'verified',
    triggers: ['腕表', '高级香水', '珠宝', 'tourbillon', '奢侈品', 'Maison', '百年', '永恒', '传承', '优雅', '克制', '微距', '暗调', '金色'],
    motifs: ['表盘齿轮与瓶身切面的缓慢展示', '液体金属玻璃的高反射表面', '光线扫过表面的高光', '匠人手部特写与传承'],
    palette: '黑、深炭灰、香槟金、琥珀，辅深酒红或午夜蓝；low-key 高对比，阴影压实但保留金属细节',
    camera: ['100mm macro 与 probe lens 为主', 'slider 与 motion control 极慢推进', '浅景深 rack focus 到刻字宝石', '45° 侧逆光勾边'],
    pacing: 'Reveal–Craft–Legacy 三段式，镜长 3–6 秒，叠化多于硬切，弦乐或低频 drone',
    antiPatterns: ['促销字幕价格折扣', '快切跳切', '高饱和卡通色', '手持晃动网红式镜头', '有美学无灵魂（缺产品线、故事与结尾点题）'],
    principles: ['P10', 'P11', 'P13'], evidence: ['#5', '#11', '#45'] },
  { id: 'ad-tech-launch', category: 'product-ad', label: '科技产品发布 Tech Product Launch', quality: 'verified',
    triggers: ['手机', '笔电', '耳机', '智能手表', '芯片', 'VR', '新品发布', '简洁', '极致', '未来感', '悬浮产品', '白背景', '发布会'],
    motifs: ['无限白或纯黑背景的 infinity cove', '产品悬浮旋转与爆炸拆解', '阳极氧化铝、玻璃、钛金属特写', '屏幕 UI 点亮的瞬间'],
    palette: '纯白、浅灰、太空黑，产品色是唯一强调色；high-key 柔光无硬阴影，中性干净不加颗粒',
    camera: ['CGI 与实拍混合，镜头近乎机械精确', 'macro 贴近材质边缘', 'orbit 环绕与 push-in 推向屏幕', 'match cut 衔接部件与整机'],
    pacing: 'Tease–Reveal–Spec，剪辑与音乐节拍同步，每个卖点一句短文案一个画面，镜长 1.5–3 秒',
    antiPatterns: ['复杂生活场景与杂乱背景', '满屏参数', '手持镜头与暗角', '暖黄怀旧滤镜', '促销价格'],
    principles: ['P12'], evidence: [] },
  { id: 'ad-fashion-film', category: 'product-ad', label: '时尚大片 Fashion Film', quality: 'verified',
    triggers: ['高定', '礼服', '秀场', '系列', 'lookbook', '风衣', '手袋', '设计师品牌', '艺术', '戏剧', '先锋', '梦幻', 'fashion film'],
    motifs: ['织物在风中的流动', '廓形与剪影、面料纹理刺绣', '超现实布景与历史典故', '模特舞蹈化雕塑化的姿态'],
    palette: '由导演概念决定（粉彩对称、复古高饱和、黑白米黑），强调 color blocking 与单一主色，可用胶片颗粒与 halation',
    camera: ['wide 展整体廓形，CU 展材质', 'Steadicam 跟拍与慢速 dolly', '180°/360° 环绕', '高速摄影拍织物'],
    pacing: 'Mood–Vignette–Tableau，由音乐主导，镜长 2–10 秒不等，品牌名常在片尾才出现',
    antiPatterns: ['平铺直叙罗列单品', '促销字幕与价格', '商超式明亮平光', '僵硬站姿展示服装', '只堆超现实美学而缺产品线与故事'],
    principles: ['P11', 'P13'], evidence: ['#11'] },
  { id: 'ad-food-beverage', category: 'product-ad', label: '食品饮料广告 Appetite Hero', quality: 'verified',
    triggers: ['汉堡', '披萨', '火锅', '咖啡', '可乐', '冰淇淋', '零食', '外卖', '诱人', '多汁', '拉丝', '流心', '倾倒', '冒热气'],
    motifs: ['蒸汽、冷凝水珠、气泡', '慢动作倾倒、芝士拉丝、酱汁流淌', '切开瞬间的断面', '新鲜食材与产品并置'],
    palette: '暖调高饱和（焦糖棕、金黄、番茄红、奶油白），色温偏暖，背景深色或奶油色低饱和让主体跳出',
    camera: ['macro 为主，probe lens 探入层次', '500–1000fps 拍倾倒飞溅', '浅景深焦点落在最诱人的纹理', '逆光勾勒蒸汽与液体边缘'],
    pacing: 'Craving → Build-up → Payoff，前 2 秒用蒸汽或倾倒抓注意，高潮是咬下拉丝碰杯，音效 ASMR 化',
    antiPatterns: ['食物冷却塌陷油腻或灰绿色调', '冷白光与荧光灯质感', '塑料感假食物', '咀嚼吞咽特写', '食材与产品不符'],
    principles: ['P12'], evidence: [] },
  { id: 'ad-automotive', category: 'product-ad', label: '汽车广告 Cinematic Automotive', quality: 'verified',
    triggers: ['轿车', 'SUV', '跑车', '电动车', '新能源', '皮卡', '公路', '赛道', '隧道', '速度', '自由', '力量', '驾驭'],
    motifs: ['车身流线反射与环境光滑过', '格栅 LED 灯组特写与轮毂旋转', '光轨与尾灯拖影', '湿润柏油路面倒影'],
    palette: '经典青橙或冷青蓝主调，夜景霓虹品红与深蓝对比，高对比深黑压暗但车漆高光保留',
    camera: ['car-to-car 或 Russian Arm 追拍', '低机位 wide 强化车身比例', '无人机俯拍道路地貌', '变形宽银幕与镜头光斑'],
    pacing: 'Reveal → Performance → Emotion，开场神秘 teaser 再整车揭示，剪点落在重拍，结尾静态 hero shot',
    antiPatterns: ['车身脏污与反射杂乱', '车轮倒转效应或轮毂错误', '违规驾驶画面', '塑料感 CGI 车漆', '车型细节随意改动'],
    principles: ['P17'], evidence: [] },
  { id: 'ad-ecommerce-demo', category: 'product-ad', label: '电商产品演示 Clear Feature Demo', quality: 'verified',
    triggers: ['淘宝', '天猫', '亚马逊', 'TikTok Shop', '详情页', '主图视频', '卖点', '功能', '演示', '开箱', '对比', '转化', '性价比', '生活方式'],
    motifs: ['产品居中占画面 60% 以上', '360° 转台与功能特写', '对比演示与尺寸参照物', '屏幕标注与数据条'],
    palette: '明亮干净 high-key，白或浅灰无缝背景，中性色温还原真实产品色；生活方式变体用自然阳光与极简家居',
    camera: ['平视或 45° 俯视稳定镜头', '中景到 macro 组合', '较深景深让产品全部对焦', '手部入画演示操作'],
    pacing: 'Hook → Problem → Demo → Proof → CTA，前 3 秒钩子，中段每 2–3 秒一个卖点，总长 15–45 秒',
    antiPatterns: ['低调光烟雾高反差的品牌大片质感', '过度慢动作与抽象隐喻', '浅景深虚化关键功能部位', '字幕遮挡产品', '滤镜导致产品色偏'],
    principles: ['P22'], evidence: ['#10'] },
  { id: 'ad-premium-spirits', category: 'product-ad', label: '高端烈酒广告 Luxury Amber Noir', quality: 'verified',
    triggers: ['威士忌', '干邑', '白兰地', '单一麦芽', '龙舌兰', '高端白酒', '醇厚', '品味', '绅士', '仪式感', '书房', '雪茄', '橡木桶'],
    motifs: ['琥珀酒液挂杯与酒体旋转', '大冰球与冰裂', '铜蒸馏器与橡木桶', '壁炉皮沙发与雪茄烟雾'],
    palette: '琥珀金、深桃花心木棕、墨黑，low-key 黑背景，暖烛光色温，酒液是画面最亮的元素',
    camera: ['液体 macro 拍倒酒与冰块碰撞', '高速摄影突出黏稠感', '逆光加边缘光勾勒瓶身杯口', '缓慢 dolly 与 motion control 环绕'],
    pacing: 'Heritage → Craft → Moment of Savoring，剪辑缓慢每镜 3–6 秒，高潮是倒酒碰杯的静默瞬间',
    antiPatterns: ['派对狂欢与醉态', '未成年或青年形象', '高调白光与廉价电商感', '暗示饮酒带来成就、性吸引力或驾驶表现', '快节奏跳切'],
    principles: ['P11', 'P13'], evidence: [] },
];

const UGC: readonly StyleDna[] = [
  { id: 'ugc-skincare-asmr', category: 'ugc-commerce', label: '护肤美妆 ASMR 日常', quality: 'verified',
    triggers: ['精华', '面霜', '洁面', '面膜', '身体乳', '卷发棒', '吹风机', '质地', '沉浸式', '早C晚A', '小红书', '种草'],
    motifs: ['泵压、滴管悬停、指尖挖面霜', '发箍毛巾包头、手指轻拍上脸', '台面瓶罐按使用顺序排列', '猫狗与家人入镜的烟火气'],
    palette: '镜前灯暖白光，奶油米与浅木色，低对比，高光略过曝，肤色偏桃粉，不用冷蓝',
    camera: ['手机架在镜边或单手持拍', '台面 45° 俯拍、人脸近景、质地微距轮换', '基本不运镜靠跳切推进', '贴近声源现场收音'],
    pacing: '0–2s 最解压的质地特写做钩子，中段每步 3–6 秒以现场收音为主，结尾水光肌 payoff 加举瓶 CTA',
    antiPatterns: ['磨皮大眼美颜', '炫技转场', '大声叫卖式口播', '纯白影棚背景', '套用商业大片手法（全程慢动作、无对白、干净隔离布景）'],
    principles: ['P7', 'P12', 'P22'], evidence: ['#1', '#18', '#46'] },
  { id: 'ugc-unboxing', category: 'ugc-commerce', label: '开箱视频 Unboxing', quality: 'verified',
    triggers: ['数码', '潮玩', '盲盒', '礼盒', '新品', '首发', '包装', '拆快递', 'unboxing'],
    motifs: ['美工刀划开胶带、撕膜、掀磁吸盖', '层层纸托与防尘袋', '取出后转 360° 配件一字排开', '猫钻纸箱与家人画外音'],
    palette: '数码类深灰桌垫配冷白光高对比；美妆 PR 类白床单配高饱和品牌色',
    camera: ['顶拍支架固定 90° 正俯拍', '穿插手持特写', '取出产品时手持微推', '锁定对焦防跑焦'],
    pacing: '0–3s 未拆的箱子配字幕，慢速划胶带延迟揭晓，掀盖时停顿，配件逐一亮相，结尾价格与购买入口',
    antiPatterns: ['盒子已经打开过', '剪掉撕膜过程', '用官方渲染图替换实拍', '全程堆 BGM 没有现场声', '3 秒内直接展示产品无悬念'],
    principles: ['P7', 'P12'], evidence: [] },
  { id: 'ugc-tryon-haul', category: 'ugc-commerce', label: '试穿 Haul Try-on', quality: 'verified',
    triggers: ['服装', '鞋包', '饰品', '跑鞋', '通勤背包', '尺码', '显瘦', '平价', '一周穿搭', 'OOTD', 'haul'],
    motifs: ['落地镜与拆开的包装袋', '手遮镜头或跳一下换装', '转身看背面、捏面料、拎吊牌', '走出卧室实穿时背景有路人同事'],
    palette: '卧室窗光加暖台灯，墙面奶白浅灰，轻微提亮但衣服颜色必须还原，不加重滤镜',
    camera: ['对镜手持拍摄手机入镜', '或三脚架仰拍全身', '全身与面料特写交替', '深景深让房间环境清晰'],
    pacing: '0–2s 快闪全部上身效果做钩子，每套 6–8 秒（上身、转身、细节），结尾尺码汇总加链接',
    antiPatterns: ['影棚模特棚拍', '液化拉腿', '只拍正面', '慢动作走秀', '滤镜改变衣服颜色', '单人全程走在空无一人的场景'],
    principles: ['P7', 'P22'], evidence: ['#8', '#31'] },
  { id: 'ugc-testimonial', category: 'ugc-commerce', label: '口播测评 / 证言', quality: 'verified',
    triggers: ['保健品', '小家电', '功效型护肤', 'App', '保温杯', '牙刷', '效果', '真的有用吗', '对比', '坚持', '测评'],
    motifs: ['手持产品举到脸侧', '车内驾驶座、厨房吧台、沙发角', '天数大字幕与前后分屏', '皱眉点头摇头的真实表情'],
    palette: '自然光为主，肤色还原中性，低饱和不调色，保持手机原相机感',
    camera: ['前置摄像头手持自拍或支架固定', '胸上近景对视镜头', 'jump cut 去掉停顿', '人脸对焦常亮'],
    pacing: '0–2s 反常识开场（别买，除非…），中段使用过程插 B-roll，结尾效果对比加结论与口头 CTA',
    antiPatterns: ['读稿腔与提词器眼神游离', '布光完美的影棚', '只夸不贬', '演员式夸张表演', '字幕使用官方广告语'],
    principles: ['P7', 'P22'], evidence: ['#40', '#52'] },
  { id: 'ugc-before-after', category: 'ugc-commerce', label: '前后对比改造 Before/After', quality: 'verified',
    triggers: ['清洁剂', '收纳', '墙贴', '灯具', '遮瑕', '染发', '洗车', '效果明显', '对比', '改造', 'CleanTok'],
    motifs: ['同一机位锁定的脏乱开场', '高压水枪划出的分界线', '手掌遮挡或打响指转场', '左右分屏与预算清单字幕'],
    palette: 'Before 偏冷偏灰低饱和、阴影发脏；After 改暖白光、提亮阴影、饱和度上调但白墙不过曝',
    camera: ['手机三脚架固定同一机位同一焦段（核心）', '竖屏 9:16', '中景全景穿插微距', '锁定 AE/AF 防呼吸'],
    pacing: '0–1.5s 展示最惨的 Before 或先闪 0.5s After，过程用 4–8 倍延时，同机位 reveal，结尾产品入镜',
    antiPatterns: ['Before 与 After 机位或焦段不同', 'After 用渲染图', '完全省略过程', 'Before 打光精美', '史诗配乐压掉原声'],
    principles: ['P7'], evidence: [] },
  { id: 'ugc-live-commerce', category: 'ugc-commerce', label: '直播带货式演示 Live-Commerce', quality: 'verified',
    triggers: ['秒杀', '清仓', '冲量', '限时', '直播', '小黄车', '家人们', '零食', '日化', '低客单价'],
    motifs: ['主播半身入镜，身后货架与手写价格牌', '产品怼近镜头、原价被划掉', '红黄贴片与库存递减', '助理递货与场控走动'],
    palette: '环形灯加大柔光箱 high-key，肤色偏粉白带美颜感，整体高饱和，贴片用正红与亮黄',
    camera: ['固定机位胸部以上中景几乎不运镜', '深景深全画面清晰', '产品凑近时的数字变焦颗粒感', '对焦在脸与产品之间跳动'],
    pacing: '0–2s 价格冲击，痛点或竞品对比，暴力演示每 3 秒一个动作，赠品加码，喊 3-2-1 上链接',
    antiPatterns: ['浅景深电影感', '慢动作', '纯配乐无人声', '不报价或价格出现太晚', '精致布景却看不到货'],
    principles: ['P7'], evidence: [] },
  { id: 'ugc-food-review', category: 'ugc-commerce', label: '美食测评 / 吃播风', quality: 'verified',
    triggers: ['零食', '方便面', '预制菜', '饮料', '奶昔', '代餐', '团购', '好吃', '测评', '探店', 'mukbang'],
    motifs: ['芝士面条拉丝与咬开横截面', '油光反射与蒸汽', '筷子挑起后停顿一秒', '店员邻桌与排队人群'],
    palette: '暖橙黄基调，红色通道与饱和度上调，高光保留油亮；夜市接受高 ISO 噪点与暖钠灯，绝不偏冷蓝',
    camera: ['手机近摄 45° 俯角拍食物', '正面中近景拍人吃', '拉丝时镜头缓慢上提跟随', '近距离收音突出咀嚼声'],
    pacing: '0–2s 最诱人的一口做冷开场，店名价格，第一口后沉默两秒再接细节，打分，结尾地址或团购',
    antiPatterns: ['假吃或咬一口就放下', '冷色调', '只拍摆盘没人吃', '全程无脑好评', '配乐盖过咀嚼声'],
    principles: ['P7', 'P12'], evidence: ['#51'] },
  { id: 'ugc-tech-handson', category: 'ugc-commerce', label: '数码产品上手 Tech Hands-on', quality: 'verified',
    triggers: ['耳机', '充电宝', '键盘', '手机配件', '智能家居', '参数', '续航', '值不值', '音质', '手感', '声音', '桌搭'],
    motifs: ['黑色或胡桃木桌面与理线', '俯拍撕膜与产品旋转展示接口', '与硬币或手机并排比尺寸', '地铁咖啡店等真实使用场景'],
    palette: '低调暗场，侧逆光勾勒产品边缘，背景深灰，偏青橙或冷蓝；桌搭类改暖木加白',
    camera: ['俯拍 top-down 与滑轨平移', 'f/1.8–2.8 浅景深', '从包装到产品做跟焦', '屏幕内容用录屏画中画不翻拍'],
    pacing: '0–2s 最惊艳的动作，抛出「花 399 值吗」，3 个核心功能各实测 5 秒，缺点或竞品对比，结尾价格与结论',
    antiPatterns: ['只念参数不演示', '用官方渲染图充数', '手抖翻拍反光屏幕', '回避缺点', '直播式喊叫'],
    principles: ['P7', 'P12'], evidence: ['#2', '#29', '#53'] },
];

const EXPLAINER: readonly StyleDna[] = [
  { id: 'exp-tech', category: 'explainer', label: '科技产品讲解 Tech Explainer', quality: 'verified',
    triggers: ['产品发布', '新品介绍', 'SaaS', 'App 介绍', '功能演示', '像苹果那样', '高级简洁', '极简', '科技感', '参数对比', '官网首屏'],
    motifs: ['悬浮缓慢自转的产品渲染', '倒角金属边与玻璃折射微距', '爆炸分解图', '悬浮 UI 卡片与单句大字'],
    palette: '纯白、近黑或浅灰渐变，辅色只用产品自身配色做唯一强调，低饱和高对比干净',
    camera: ['缓慢 dolly-in 与微距 slider', '绕产品 orbit', 'UI 段用 2.5D 推拉', 'match cut 与 zoom-through'],
    pacing: '一句话价值主张 → 真人痛点 → 3 个核心功能各 8–12 秒（文案、演示、结果）→ 参数 → 定格 logo',
    antiPatterns: ['旋转立方体与故障转场', '同一画面多个视觉焦点', '库存商务素材', '革命性颠覆式夸张配音', '屏幕堆整段文字'],
    principles: [], evidence: [] },
  { id: 'exp-brand-story', category: 'explainer', label: '电影感品牌故事 Cinematic Brand Story', quality: 'verified',
    triggers: ['品牌故事', '品牌形象片', '品牌宣言', '情感共鸣', '走心', '纪录片质感', '创始人故事', '匠人精神', '店铺宣传片', '日式纪实', '无人出镜'],
    motifs: ['真实人物面部特写（汗水、呼吸、眼神）', '手脚与工具的情感细节', '晨昏逆光的空旷环境', '日式纪实变体不拍人脸，以食材器具台面与光影为主体'],
    palette: '暖琥珀金与肤色，辅深青蓝阴影，中低饱和、黑位微抬、胶片颗粒；日式纪实用原木米白与食材本色',
    camera: ['手持跟拍与 Steadicam 平滑跟随', '特写与大远景交替', '120fps 慢动作拍汗珠尘埃', '声音先行的 J-cut / L-cut'],
    pacing: '安静开场 → 建立人物与困境 → 蒙太奇加速 → 高潮后静默一拍 → 结尾 tagline 加 logo，品牌最晚出现',
    antiPatterns: ['摆拍式微笑与广告表情', '前 10 秒露出产品与 logo', '库存音乐与励志鸡汤旁白', '过度磨皮与过亮棚拍', '要求无人出镜时硬加人物面部特写'],
    principles: ['P11'], evidence: ['#17'] },
  { id: 'exp-whiteboard-mg', category: 'explainer', label: '白板 / 动画讲解（先定路数）', quality: 'verified',
    triggers: ['白板动画', '手绘', '马克笔', '动画讲解', '科普动画', 'MG 动画', '一分钟看懂', '儿童科普', '绘本感', '拟人化', '定格', '黏土', '乐高', '毛毡', '拼贴'],
    routes: ['白板手绘线稿', 'Kurzgesagt 式扁平 MG', '现代 2D 卡通（#59）', '黏土定格（#12 科普 / #25 治愈）', '乐高定格（#36）', '拼贴（#66）与毛毡（#34）'],
    motifs: ['手持马克笔实时绘制线稿', '火柴人与图标化物件', '流程箭头与思维导图生长', '抽象概念拟人化成有旅程的主角'],
    palette: '白板版白底黑线加 1–2 个强调色；MG 版深蓝紫底配高饱和扁平色块；定格版保留实物材质色与实景布光',
    camera: ['2D 虚拟摄影机缓慢平移推近', '全景图解与局部放大交替', '擦除重画与形状 morph 转场', '定格版用微距实拍浅景深'],
    pacing: '反直觉问题钩子 → 定义问题 → 3–4 个逻辑步骤各先画后讲（每 4–6 秒更新视觉）→ 回扣开头 → 行动号召',
    antiPatterns: ['真实人像与写实摄影素材', '画面静止超过 5 秒', '混用多种插画风格而不定路数', '屏幕整段复述旁白', '定格做得过于丝滑'],
    principles: ['P15', 'P16', 'P24'], evidence: ['#12', '#19', '#25', '#34', '#36', '#59', '#66'] },
  { id: 'exp-historical-doc', category: 'explainer', label: '历史纪录剧情片 Historical Documentary', quality: 'verified',
    triggers: ['历史', '朝代', '古代', '战役', '情景再现', '年代感', '考古', '行业史', '老行业', '传统技艺', '医学史', '麻醉', '中医', '酿酒', '古今对比'],
    motifs: ['研墨、系甲带、展开信函的手部特写', '火把油灯下的半脸侧影', '逆光尘土与古地图文物', '无脸再现：背影、遮挡、剪影'],
    palette: '土黄赭石暗红，辅靛青青铜绿，低饱和、黑位轻抬、胶片颗粒；古今对比时现代段转干净中性偏冷',
    camera: ['慢速 push-in 与 slider 横移', '浅景深，极端特写与大远景对比', '烟尘火光遮挡转场', 'match cut（古代工具 → 现代器械）'],
    pacing: '静默再现加悬念旁白 → 地图档案年份 → 再现主体每镜 3–6 秒 → 回到今日遗址留反问；行业史先古代工具再硬切现代',
    antiPatterns: ['现代物品入画（古今对比的现代段除外）', '高饱和糖果色与塑料盔甲', '演员夸张表演或直视镜头', 'MTV 式快切与故障特效', '凭空编造史实数字'],
    principles: ['P14'], evidence: ['#7'] },
  { id: 'exp-interview', category: 'explainer', label: '访谈 / 证言叙事 Interview Narrative', quality: 'verified',
    triggers: ['客户证言', '用户故事', '案例分享', '人物访谈', '口述', '创始人故事', '人物纪实', 'testimonial', 'case study'],
    motifs: ['受访者在自己的工作生活空间，背景可辨认', '直视或略偏镜头的中近景', '劳作中的手部与工具 B-roll', '老照片旧物与手写笔记'],
    palette: '肤色优先，暖中性，主色取自受访者环境，轻度对比柔和高光，背景用台灯窗光制造层次',
    camera: ['双机位（正面中近景加侧 45° 特写）', '固定或缓慢 push-in 浅景深', 'B-roll 手持跟拍与细节特写', 'J-cut / L-cut 转场'],
    pacing: '金句钩子 → 身份建立 → 冲突困境（每 6–10 秒切 B-roll）→ 转折与结果 → 一句总结性证言',
    antiPatterns: ['背稿或念提词器', '通篇赞美与广告腔', '炫技转场特效', '配乐盖过人声', '统一摆拍的假笑', 'B-roll 与讲述无关'],
    principles: [], evidence: [] },
  { id: 'exp-tutorial', category: 'explainer', label: '教程 / 实操演示 Tutorial', quality: 'verified',
    triggers: ['教程', '教学', '怎么做', '步骤', 'how-to', 'DIY', '手工', '食谱', '做菜', '录屏', '软件操作', '新手入门', '一步步'],
    motifs: ['90° 俯拍工作台，只出现手与操作对象', '材料工具整齐平铺', '步骤编号字卡与进度条', '录屏光标高亮与快捷键提示'],
    palette: '中性浅灰、白、原木背景让主体色突出，high-key 对比适中，白平衡精准无色偏',
    camera: ['主机位垂直俯拍固定', '辅机位 45° 侧拍关键技巧', '录屏整屏 → 局部放大 → 光标跟随', '跳切去除等待，重复动作 4–8 倍加速'],
    pacing: '成品 hero shot 钩子 → 材料清单与预估时间 → 每步 5–15 秒一步一画面 → 成品展示加小贴士',
    antiPatterns: ['省略关键步骤或镜头遮住操作区', '晃动手持与大幅运镜', '步骤间插无关氛围空镜', '背景杂乱抢主体', '配乐淹没操作音'],
    principles: [], evidence: [] },
];

/**
 * Beat skeletons for a request that gives a sentence and no structure of its
 * own. The four-beat one comes from the App's director-mode panel (hardcoded
 * there in 2026-06, behind a panel with no entry point); the others are the
 * distillation's own structure templates with their evidence. Saga uses one
 * only when the user wrote no script, no shots and no timecodes: a user who
 * brought a structure keeps it (P27).
 */
export type StructureTemplate = {
  id: string;
  label: string;
  /** Which categories it fits; 'all' for the generic four-beat one. */
  scope: StyleCategory[] | 'all';
  /** Styles it is the first choice for. */
  preferredStyles?: string[];
  /** One line per beat: share of the total length, what happens, how it is shot. */
  beats: Array<{ span: string; beat: string; camera: string }>;
  evidence: string[];
};

export const STRUCTURE_TEMPLATES: readonly StructureTemplate[] = [
  {
    id: 'four-beat-mv', label: '四段式 · MV', scope: ['music-mv', 'hiphop-mv'], evidence: ['导演模式面板'],
    beats: [
      { span: '0–15%', beat: '开场建立情绪：一个镜头立刻立住世界观', camera: '慢速推进，浅景深，前奏留出空间感' },
      { span: '15–40%', beat: '音乐人格显影：只围绕指定片段展开，人物状态、城市、身体动作或抽象意象开始同步节奏', camera: '中近景与细节特写交替，避免信息过满' },
      { span: '40–85%', beat: '高潮记忆点：颜色、动作或情绪形成一次明确撞击', camera: '更强对比光，镜头可从稳定转向轻微漂浮或手持' },
      { span: '最后 15%', beat: '收束留余味：像片段结束后仍留在身体里的回声，不默认拍完整首歌', camera: '慢慢远离，或停在一个反射、背影、光源上' },
    ],
  },
  {
    id: 'four-beat-ad', label: '四段式 · 商业广告', scope: ['product-ad'], evidence: ['导演模式面板'],
    beats: [
      { span: '0–15%', beat: '开场建立情绪：一个镜头立刻立住世界观', camera: '慢速推进，浅景深，环境声留出空间感' },
      { span: '15–40%', beat: '产品通过手、光、材质或使用场景出现，不要像普通商品展示', camera: '中近景与细节特写交替，避免信息过满' },
      { span: '40–85%', beat: '记忆点：产品与人物情绪形成一次明确撞击', camera: '更强对比光，镜头从稳定转向轻微漂浮' },
      { span: '最后 15%', beat: '产品信息收束但保持情绪，不要突然变成 PPT；有真人出演时这里放点题台词（P11）', camera: '慢慢远离，或停在一个反射、背影、光源上' },
    ],
  },
  {
    id: 'beauty-three-act', label: '大牌商拍三段式', scope: ['product-ad'], preferredStyles: ['ad-cosmetics', 'ad-luxury-product'], evidence: ['#3'],
    beats: [
      { span: '0–40%', beat: '极端产品微距：多角度、多位置、内外兼顾', camera: 'macro 加慢动作，120fps 以上拍质地' },
      { span: '40–75%', beat: '人物肩上近景，传达品质感与冷静；全程无对白，只有产品 ASMR 与 BGM', camera: '85–135mm 长焦压缩，浅景深' },
      { span: '最后 25%', beat: '产品回归主角：完整特写加推镜，一句点题落在产品主张上', camera: '缓慢推镜收尾' },
    ],
  },
  {
    id: 'ugc-seven-scene', label: 'UGC 种草七场景', scope: ['ugc-commerce'], evidence: ['#18'],
    beats: [
      { span: '0–5%', beat: '钩子：最解压或最惊艳的那一下', camera: '质地微距或产品特写' },
      { span: '5–20%', beat: '展示：产品与场景全貌，配一句字幕说清是什么', camera: '台面 45° 俯拍' },
      { span: '20–70%', beat: '使用演示：每一步 3–6 秒，现场收音为主', camera: '近景与手部特写轮换' },
      { span: '70–90%', beat: '效果呈现：前后对比或成品状态', camera: '同机位对比' },
      { span: '最后 10%', beat: 'CTA：举起产品贴近镜头', camera: '手持近景' },
    ],
  },
  {
    id: 'concept-three-act', label: '概念 MV 三幕', scope: ['music-mv'], preferredStyles: ['mv-surreal-fashion'], evidence: ['#38'],
    beats: [
      { span: '0–30%', beat: '降临与现身：主体进入世界', camera: '仰拍神性构图，缓推' },
      { span: '30–70%', beat: '对峙与变形：机甲、液态金属或身份转换', camera: '环绕与推拉交替' },
      { span: '最后 30%', beat: '神性回响：收束于仪式感定格，结尾留一句定调', camera: '定格或极慢推' },
    ],
  },
  {
    id: 'explainer-six-scene', label: '科普六场景', scope: ['explainer'], evidence: ['#59'],
    beats: [
      { span: '0–10%', beat: '反直觉问题开场', camera: '主角或图形入画' },
      { span: '10–30%', beat: '定义问题，画出核心概念', camera: '全景图解' },
      { span: '30–80%', beat: '三到四个逻辑步骤，每步先画后讲，每 4–6 秒更新视觉', camera: '局部放大与平移' },
      { span: '80–95%', beat: '回扣开头的问题', camera: '拉远看全图' },
      { span: '最后 5%', beat: '行动号召或延伸思考', camera: '定格' },
    ],
  },
];

/**
 * How a music style's sections map to cut points. The VIBES audio analyser
 * (install_audio_emotion / analyze_audio / analyze_audio_emotion) was
 * designed to fill the numbers here — BPM, energy curve, peaks, section
 * boundaries — but those tools were never written, in this engine or in the
 * CLI. Until they are, the mapping below is what Saga uses, and the user's
 * own emotional verdict outranks any of it (P28).
 */
export const MUSIC_STRUCTURE: Readonly<Record<string, string>> = {
  'mv-kpop-choreo': '主歌用个人特写与场景叙事，预副歌快切升格，副歌全员正面编舞，桥段慢镜情绪特写，dance break 用一镜到底的完整舞段',
  'mv-edm-festival': 'intro 与 breakdown 用 3–6 秒长镜，build-up 随 snare roll 从每 4 拍加速到每 1/2 拍，drop 第一拍同时爆发，drop 段每镜 0.3–0.7 秒',
  'mv-rock-band': '按乐器轮流点名：riff 切吉他、鼓 fill 切鼓手、人声切主唱；主歌每镜 2–3 秒，副歌 0.5–1 秒，solo 停在吉他手身上 3–8 秒',
  'mv-nocturnal-rnb': '不卡每一拍，切点落在小节线或乐句开头，跟人声与合成器铺底而不是跟鼓，每镜 3–6 秒，转折处硬切黑场',
  'mv-latin-reggaeton': '跟 dembow 律动，在 boom 上切镜、在 chick 上做小幅推拉，每镜 1–2 秒，副歌多机位快切加群舞',
  'mv-mandopop-ballad': '跟歌词与情绪而不是鼓点：唱到雨就出现雨，主歌铺陈故事，副歌推向情绪高点，桥段到最后一次副歌是剧情转折',
  'mv-hyperpop-glitch': '与音乐的故障同步：变调、切片、失真处画面要有对应的撕裂、卡帧或倒放；极乱之后突然切静',
  'mv-indie-lofi': '不卡点，剪辑点与节拍松散对应甚至故意错开，单镜 5–15 秒，情绪平直无高潮爆发',
  'hh-trap': '130–160 BPM，hi-hat roll 加速时闪切，adlib 触发即时切，节拍 drop 时镜头震动或 speed ramp',
  'hh-drill': '140 BPM 左右，切在 kick 与 bass slide 上，段落内长镜积累压迫，副歌群体 walk 时快速切',
  'hh-east-coast': '跟 85–95 BPM 的 boom bap，在 snare 上切，每镜 2–4 秒，段落间慢叠化或黑场',
};

/**
 * The wording the professional path asks with. Taken from the director-mode
 * panel's field prompts, which were better written than anything generated
 * from scratch: the emotional verdict outranks the analysis (P28), and the
 * exclusions are hard constraints (P27).
 */
export const ELICITATION: Readonly<Record<string, { question: string; hint: string }>> = {
  emotionalVerdict: {
    question: '这段作品真正是什么情绪？',
    hint: '孤独、冷、刺骨、失眠、空洞、厚重、痛之入骨、狂喜、性感、虚无……这一项优先级最高，会压过音频分析和风格建议',
  },
  exclusions: {
    question: '有什么绝对不要出现的？',
    hint: '地点、颜色、季节、材质，以及不要拍成什么。写下来就是硬约束，不会被风格建议盖掉',
  },
  protagonistRelation: {
    question: '主角关系是什么？',
    hint: '一个人、两个人、缺席的人、幻觉、自我分裂、非真人角色……多角色时每个角色要绑自己的参考图',
  },
  songSegment: {
    question: '只拍哪一段？',
    hint: '起止时间或段落名，例如 00:42-01:18、副歌第一遍。不指定就只按总时长走，不默认拍完整首歌',
  },
  commercialGoal: {
    question: '商业目标或品牌感觉？',
    hint: '高级、可信、性感、效率、治愈、反叛、奢侈……这决定镜头为转化服务还是为情绪服务',
  },
  audience: {
    question: '目标人群是谁？',
    hint: '他们想要什么、害怕什么。商业广告缺了这一项就会拍成空泛 MV',
  },
};

export function structureTemplateById(id: string): StructureTemplate | undefined {
  return STRUCTURE_TEMPLATES.find((template) => template.id === id);
}

/** Every style the library knows, in match order (verified anchors first). */
export const STYLE_LIBRARY: readonly StyleDna[] = [...HIPHOP, ...MUSIC_MV, ...PRODUCT_AD, ...UGC, ...EXPLAINER];

export function principleById(id: PrincipleId): Principle {
  const found = STYLE_PRINCIPLES.find((principle) => principle.id === id);
  if (!found) throw new Error(`unknown principle ${id}`);
  return found;
}

export function styleById(id: string): StyleDna | undefined {
  return STYLE_LIBRARY.find((style) => style.id === id);
}
