// 设计风格类型定义

export interface DesignStyle {
  name: string;
  english: string;
  aliases: string[];
  description: string;
  key_elements: string[];
  color_palette: string[];
  prompt_cues: {
    composition: string[];
    typography: string[];
    materiality: string[];
    color: string[];
    motion: string[];
    micro_details: string[];
  };
  avoid: string[];
  use_cases: string[];
  typography: {
    headings: string;
    body: string;
    weight: string[];
    spacing: string;
    lineHeight: string;
  };
  layout: {
    grid: string;
    spacing: string;
    maxWidth: string;
    alignment: string;
    negativeSpace: string;
  };
  compatibility: {
    technical: number;
    visual: number;
    functional: number;
    emotional: number;
    practical: number;
  };
}

type PromptCues = DesignStyle['prompt_cues'];

type StylePreset = Pick<DesignStyle,
  'name' | 'english' | 'aliases' | 'description' | 'key_elements' |
  'color_palette' | 'prompt_cues' | 'avoid' | 'use_cases'
> & {
  slug: string;
  density: 'low' | 'medium' | 'high';
  emotional: number;
};

const cues = (
  composition: string[],
  typography: string[],
  materiality: string[],
  color: string[],
  motion: string[],
  micro_details: string[],
): PromptCues => ({
  composition,
  typography,
  materiality,
  color,
  motion,
  micro_details,
});

const STYLE_PRESETS: StylePreset[] = [
  {
    slug: 'minimalism',
    name: '极简主义',
    english: 'Minimalism',
    aliases: ['minimal', 'less is more', '极简', '留白', '克制'],
    description: '以尽可能少的元素建立清晰秩序，依靠留白、比例、材质与节奏传达克制而精准的美感。',
    key_elements: ['留白', '比例', '秩序', '少量材质'],
    color_palette: ['#ffffff', '#0f1115', '#e7e5df', '#9aa0a6'],
    prompt_cues: cues(
      ['单一主焦点', '大面积负空间', '严格网格', '低噪声层级'],
      ['轻字重标题', '中性无衬线', '少量字号层级'],
      ['哑光表面', '精细边界', '真实阴影但低对比'],
      ['黑白灰为主', '一个功能性色彩点'],
      ['缓慢淡入', '细微位移', '无夸张弹性'],
      ['边缘锐度', '微弱纸纹', '细小接缝'],
    ),
    avoid: ['装饰过量', '多焦点争夺', '无意义渐变', '空洞高级感'],
    use_cases: ['SaaS', '作品集', '高端产品页', '工具界面'],
    density: 'low',
    emotional: 72,
  },
  {
    slug: 'maximalism',
    name: '极繁主义',
    english: 'Maximalism',
    aliases: ['maximal', '极繁', '高密度', '丰盛', '装饰主义'],
    description: '通过高密度装饰、复杂图案、丰富材质和信息叠加制造丰盛、张扬且近乎溢出的视觉体验。',
    key_elements: ['高密度', '图案', '装饰', '层叠'],
    color_palette: ['#111111', '#ff3d7f', '#ffd166', '#3a86ff'],
    prompt_cues: cues(
      ['多层前中后景', '重复图案', '密集但分区明确', '强中心视觉'],
      ['高对比标题', '多字体需有主次', '装饰性首字或标签'],
      ['织物', '金属箔', '陶瓷釉面', '混合纹理'],
      ['高饱和撞色', '深底托住亮色', '多色但角色清楚'],
      ['层层揭示', '装饰元素错峰进入', '视差感'],
      ['刺绣纹理', '颗粒', '金属划痕', '边框细节'],
    ),
    avoid: ['不可读正文', '随机堆素材', '所有元素同权重', '移动端拥挤'],
    use_cases: ['活动页', '时尚视觉', '音乐/文化海报', '节日专题'],
    density: 'high',
    emotional: 92,
  },
  {
    slug: 'constructivism',
    name: '构成主义',
    english: 'Constructivism',
    aliases: ['constructivist', '构成', '俄国先锋', '宣传构图', 'industrial poster'],
    description: '强调几何结构、斜线张力、工业感与宣传性编排，整体具有鲜明的秩序感和动员感。',
    key_elements: ['斜线', '几何块面', '工业红黑', '宣传排版'],
    color_palette: ['#d71920', '#111111', '#f2f0e8', '#8a8f98'],
    prompt_cues: cues(
      ['斜向动势', '圆形与矩形切割', '强网格轴线', '海报式层级'],
      ['粗黑无衬线', '窄体大写', '斜排文字块'],
      ['粗纸', '工业金属', '印刷套色偏差'],
      ['红黑米白', '低色数高对比'],
      ['块面滑入', '机械节拍', '硬切转场'],
      ['纸张纤维', '油墨压痕', '轻微错版'],
    ),
    avoid: ['柔和梦幻', '无结构倾斜', '过度照片写实', '装饰无功能'],
    use_cases: ['海报', '活动视觉', '品牌宣言页', '编辑专题'],
    density: 'medium',
    emotional: 82,
  },
  {
    slug: 'deconstructivism',
    name: '解构主义',
    english: 'Deconstructivism',
    aliases: ['deconstructive', '解构', '错位', '破碎网格', 'fragmented'],
    description: '通过错位、破碎、扭转与不稳定结构打破传统秩序，营造紧张、尖锐且动态的形式语言。',
    key_elements: ['错位', '破碎网格', '扭转', '非对称'],
    color_palette: ['#f6f2ea', '#171717', '#e63946', '#457b9d'],
    prompt_cues: cues(
      ['断裂网格', '错位卡片', '不稳定对角线', '可读锚点保留'],
      ['切片标题', '错落基线', '文字块互相咬合但不重叠'],
      ['裂纹玻璃', '混凝土', '折叠纸面', '尖锐边界'],
      ['中性底色加危险色', '局部高对比'],
      ['错位回弹', '碎片重组', '快速偏移'],
      ['裂缝', '纸边毛刺', '边缘阴影'],
    ),
    avoid: ['真实可用信息被破坏', '文本互相覆盖', '纯随机旋转', '无焦点混乱'],
    use_cases: ['艺术展页', '实验品牌', '音乐视觉', '专题叙事'],
    density: 'high',
    emotional: 88,
  },
  {
    slug: 'neo-expressionism',
    name: '新表现主义',
    english: 'Neo-Expressionism',
    aliases: ['neo expressionist', '表现主义', '粗粝笔触', '高情绪', 'gestural'],
    description: '以强烈笔触、夸张形体和高情绪浓度表达主观感受，画面常显粗粝、激烈和不安。',
    key_elements: ['粗粝笔触', '夸张形体', '手工质感', '高情绪'],
    color_palette: ['#1d1d1d', '#f94144', '#f3722c', '#f9c74f'],
    prompt_cues: cues(
      ['大笔触背景', '强轮廓主角', '不规则边界', '情绪优先层级'],
      ['手写感标题', '粗重字重', '带压力痕迹'],
      ['厚涂', '炭笔', '撕裂纸', '脏污表面'],
      ['灼热色块', '暗底压迫', '局部酸亮'],
      ['笔触蔓延', '抖动线条', '爆发式显现'],
      ['颜料堆积', '飞溅', '擦痕', '粗纸颗粒'],
    ),
    avoid: ['干净企业模板', '过度对称', '情绪被磨平', '廉价涂鸦化'],
    use_cases: ['音乐封面', '文化海报', '艺术项目', '强观点页面'],
    density: 'high',
    emotional: 95,
  },
  {
    slug: 'neoclassicism',
    name: '新古典主义',
    english: 'Neoclassicism',
    aliases: ['neo classical', '古典', '庄重', '柱式', 'symmetry'],
    description: '借用古典比例、对称、柱式与庄重秩序，呈现理性、克制和纪念碑式的优雅气质。',
    key_elements: ['对称', '古典比例', '柱式暗示', '纪念碑感'],
    color_palette: ['#f8f3e7', '#2f2a24', '#b08d57', '#d8d0c2'],
    prompt_cues: cues(
      ['中轴对称', '三段式构图', '纪念碑比例', '秩序化留白'],
      ['高对比衬线', '小型大写', '优雅字距'],
      ['大理石', '石膏', '金箔', '磨砂纸'],
      ['象牙白', '石灰灰', '暗金', '深棕'],
      ['庄重淡入', '缓慢升降', '仪式感切换'],
      ['石材纹理', '雕刻边缘', '细金线'],
    ),
    avoid: ['俗气欧式花纹', '过量金色', '宫廷风堆砌', '现代控件失焦'],
    use_cases: ['奢侈品', '文化机构', '高端邀请函', '品牌历史页'],
    density: 'medium',
    emotional: 78,
  },
  {
    slug: 'neo-futurism',
    name: '新未来主义',
    english: 'Neo-Futurism',
    aliases: ['neo futurist', '未来主义', '流线', 'parametric', 'high tech'],
    description: '以流线曲面、科技感材质和高速动态线条描绘一种面向未来的精密、轻盈与前瞻感。',
    key_elements: ['流线', '轻量曲面', '发光边缘', '精密科技'],
    color_palette: ['#050b14', '#d9f7ff', '#00d1ff', '#9cffcb'],
    prompt_cues: cues(
      ['流线曲面', '悬浮层', '参数化网格', '速度线'],
      ['精密无衬线', '数字读数', '窄体技术标签'],
      ['玻璃', '铝合金', '碳纤维', '发光树脂'],
      ['深底冷光', '青蓝与薄荷高光', '低饱和背景'],
      ['轨迹线', '柔滑变形', '光带扫过'],
      ['微刻线', '折射', '高光边缘', '细颗粒雾'],
    ),
    avoid: ['赛博朋克脏乱误用', '过度霓虹', '没有功能的科幻装饰', '全屏暗蓝单色'],
    use_cases: ['科技产品', '汽车/硬件', 'AI 工具', '未来城市叙事'],
    density: 'medium',
    emotional: 86,
  },
  {
    slug: 'neo-brutalism',
    name: '新粗野主义',
    english: 'Neo-Brutalism',
    aliases: ['neobrutalism', 'brutalist', '粗野', '硬边框', 'raw digital'],
    description: '保留粗野主义的直接、厚重和原始力量，同时用高对比色和数字语汇强化当代冲击感。',
    key_elements: ['硬边框', '厚重阴影', '直接排版', '高对比'],
    color_palette: ['#fff200', '#000000', '#ff4d00', '#ffffff'],
    prompt_cues: cues(
      ['大块面', '硬边容器', '裸露网格', '明显边框'],
      ['超粗标题', '系统字体', '直白标签'],
      ['纸板', '混凝土', '粗颗粒阴影', '实体按钮'],
      ['黑白加警示亮色', '原色冲突'],
      ['硬切', '按钮按压位移', '低帧率弹跳'],
      ['网点', '粗糙边缘', '印刷错位'],
    ),
    avoid: ['圆润玻璃拟态', '细腻奢华', '阴影糊成一片', '信息层级不清'],
    use_cases: ['开发者工具', '活动页', '独立品牌', '实验 UI'],
    density: 'medium',
    emotional: 84,
  },
  {
    slug: 'surrealism',
    name: '超现实主义',
    english: 'Surrealism',
    aliases: ['surreal', '梦境', '潜意识', 'uncanny', '超现实'],
    description: '把梦境逻辑、潜意识联想与现实物象并置，形成熟悉却违和、怪诞又诗性的场景。',
    key_elements: ['梦境并置', '尺度错乱', '真实材质', '潜意识隐喻'],
    color_palette: ['#0b1026', '#e9dcc9', '#b86b77', '#6c8ead'],
    prompt_cues: cues(
      ['现实空间中放置不合逻辑物体', '尺度错位', '清晰主隐喻'],
      ['克制文字', '像展览说明一样冷静'],
      ['写实物体', '柔软融化', '镜面水', '云雾'],
      ['自然色加异常高光', '梦境低饱和'],
      ['缓慢漂浮', '物体变形', '无重力过渡'],
      ['凝结水珠', '旧墙纹理', '柔雾', '轻微胶片颗粒'],
    ),
    avoid: ['随机怪图', '恐怖元素失控', '隐喻不可读', 'AI 塑料感'],
    use_cases: ['艺术视觉', '品牌概念', '影像主视觉', '叙事网页'],
    density: 'medium',
    emotional: 90,
  },
  {
    slug: 'bauhaus',
    name: '包豪斯风格',
    english: 'Bauhaus Style',
    aliases: ['bauhaus', '功能主义', '三原色', '基础几何', 'modernist'],
    description: '融合功能主义、基础几何与清晰网格，在艺术、建筑与工业设计之间建立高效统一。',
    key_elements: ['基础几何', '功能主义', '网格', '三原色'],
    color_palette: ['#f5f1e8', '#d71920', '#1d4ed8', '#f7c600'],
    prompt_cues: cues(
      ['圆方三角组织', '清晰网格', '功能先行', '模块化排布'],
      ['几何无衬线', '规整字重', '清晰标签'],
      ['纸张', '钢管', '木材', '工业涂层'],
      ['米白底', '红蓝黄黑少量使用'],
      ['几何组装', '模块滑入', '机械但轻快'],
      ['印刷纹理', '几何边缘', '轻微套印'],
    ),
    avoid: ['复杂装饰', '仿古纹样', '没有网格', '三原色过量'],
    use_cases: ['设计系统', '教育页面', '品牌规范', '产品说明'],
    density: 'medium',
    emotional: 74,
  },
  {
    slug: 'biomorphic',
    name: '生物形态风格',
    english: 'Biomorphic Style',
    aliases: ['biomorphic', '有机', '细胞', '生物形态', 'organic forms'],
    description: '从细胞、器官、骨骼与自然生长形态中提取语言，形成柔软、有机且连续的曲线结构。',
    key_elements: ['有机曲线', '细胞形态', '连续结构', '柔软边界'],
    color_palette: ['#f4efe6', '#31572c', '#90a955', '#d9ed92'],
    prompt_cues: cues(
      ['连续曲线', '细胞状模块', '自然生长路径', '非直角容器'],
      ['圆润无衬线', '柔和字重', '呼吸感行距'],
      ['凝胶', '骨白陶瓷', '叶面', '半透明膜'],
      ['生态绿', '骨白', '湿润高光', '低对比渐变'],
      ['生长展开', '柔性形变', '呼吸脉冲'],
      ['微孔', '水膜', '叶脉', '半透明边缘'],
    ),
    avoid: ['医学恐怖感误用', '黏腻低俗', '随机 blob', '可读性被曲线破坏'],
    use_cases: ['健康科技', '生态产品', '空间设计', '柔性品牌'],
    density: 'medium',
    emotional: 82,
  },
  {
    slug: 'art-deco',
    name: '装饰艺术风格',
    english: 'Art Deco Style',
    aliases: ['art deco', '装饰艺术', '摩登', '黑金', 'streamlined luxury'],
    description: '以对称、几何、金属感与奢华装饰构成摩登时代的精致、华丽和都市高级感。',
    key_elements: ['对称', '金属', '放射线', '奢华几何'],
    color_palette: ['#0b0b0c', '#d4af37', '#f5f0e6', '#004b5a'],
    prompt_cues: cues(
      ['中轴对称', '放射线', '阶梯几何', '竖向纪念碑比例'],
      ['高对比衬线或几何标题', '金属字距', '窄体标签'],
      ['抛光金属', '黑漆', '大理石', '玻璃'],
      ['黑金象牙', '祖母绿或深青点缀'],
      ['光芒展开', '镜面扫光', '庄重推进'],
      ['金属拉丝', '宝石切面', '精细边框'],
    ),
    avoid: ['廉价土豪金', '过多花纹', '现代内容被复古遮盖', '低对比金字'],
    use_cases: ['奢侈品', '酒店/地产', '香水珠宝', '颁奖活动'],
    density: 'high',
    emotional: 86,
  },
  {
    slug: 'memphis',
    name: '孟菲斯风格',
    english: 'Memphis Style',
    aliases: ['memphis', '孟菲斯', 'sottsass', 'postmodern pattern', '糖果几何'],
    description: '用跳跃配色、夸张图形和戏谑装饰挑战现代主义的严肃感，显得轻佻、活泼又反常规。',
    key_elements: ['跳跃配色', '几何图案', '波浪线', '反常规'],
    color_palette: ['#ff6b6b', '#4ecdc4', '#ffe66d', '#1a535c'],
    prompt_cues: cues(
      ['错落几何', '图案块面', '趣味物件陈列', '不规则但清楚的卡片层'],
      ['粗圆标题', '玩具感标签', '少量几何装饰字'],
      ['塑料层压板', '亮面陶瓷', '彩色金属', '贴纸表面'],
      ['糖果色撞色', '黑白图案托底', '亮色角色分明'],
      ['弹跳进入', '几何旋转', '图案错峰闪现'],
      ['塑料高光', '半调网点', '细小划痕', '贴纸边'],
    ),
    avoid: ['儿童化失控', '所有区域都高饱和', '控件不可用', '图案压过内容'],
    use_cases: ['潮流电商', '创意海报', '儿童/玩具但需高级控制', '社交视觉'],
    density: 'high',
    emotional: 90,
  },
  {
    slug: 'neo-pop',
    name: '新波普艺术',
    english: 'Neo-Pop Art',
    aliases: ['neo pop', 'pop art', '波普', '消费符号', 'comic commercial'],
    description: '吸收大众文化、消费符号与鲜明色彩，把流行图像转化为直接、醒目且传播性极强的视觉表达。',
    key_elements: ['消费符号', '粗描边', '亮色块', '传播性'],
    color_palette: ['#ff006e', '#fbff12', '#3a86ff', '#000000'],
    prompt_cues: cues(
      ['单一大符号', '漫画分镜', '商品符号放大', '强 CTA 层级'],
      ['粗体标题', '漫画感气泡但少文字', '强描边标签'],
      ['亮面塑料', '印刷网点', '贴纸', '包装纸'],
      ['原色高饱和', '黑白粗描边'],
      ['爆点缩放', '贴纸弹入', '分镜切换'],
      ['Ben-Day 网点', '纸张颗粒', '油墨边缘'],
    ),
    avoid: ['版权角色复刻', '廉价广告模板', '文字过多', '符号堆叠无主角'],
    use_cases: ['营销视觉', '社交活动', '消费品牌', '包装概念'],
    density: 'high',
    emotional: 88,
  },
  {
    slug: 'glitch',
    name: '故障艺术',
    english: 'Glitch Art',
    aliases: ['glitch', '故障', 'rgb split', 'datamosh', 'signal noise'],
    description: '把数字错误、压缩损伤、信号干扰和系统失真当作美学资源，突出技术媒介自身的脆弱性。',
    key_elements: ['信号错位', 'RGB 分离', '压缩损伤', '扫描线'],
    color_palette: ['#050505', '#00f5ff', '#ff00aa', '#f8f8f8'],
    prompt_cues: cues(
      ['局部信号撕裂', '横向错位条', '主体仍可辨认', '数据层叠'],
      ['等宽字体', '终端标签', '断裂标题'],
      ['CRT 屏幕', '像素噪声', '压缩块', '玻璃屏'],
      ['黑底青粉', '高亮像素', '低色深'],
      ['信号跳帧', '扫描线滚动', '短暂 RGB 分离'],
      ['压缩块', '坏像素', '扫描线', '色散边缘'],
    ),
    avoid: ['全图不可读', '随机噪声覆盖内容', '过度赛博朋克化', '闪烁伤眼'],
    use_cases: ['音乐视觉', '安全/黑客叙事', '数字艺术', '科技专题'],
    density: 'high',
    emotional: 87,
  },
  {
    slug: 'collage',
    name: '拼贴艺术',
    english: 'Collage Art',
    aliases: ['collage', '拼贴', 'photomontage', '剪贴', 'mixed media'],
    description: '通过异质图像、材质和语境的剪切拼接，让新的意义在并置、冲突与断裂中生成。',
    key_elements: ['剪切', '纸张纹理', '图像并置', '断裂边缘'],
    color_palette: ['#f2eadf', '#2b2b2b', '#c1121f', '#669bbc'],
    prompt_cues: cues(
      ['撕纸层叠', '照片与图形并置', '清晰剪切边', '语义对照'],
      ['打字机字体', '报刊标题', '手写注记少量'],
      ['旧纸', '胶带', '照片纸', '布料'],
      ['复古纸色', '少量红蓝强调', '印刷褪色'],
      ['纸片翻入', '胶带贴合', '层级揭露'],
      ['纸纤维', '折痕', '胶带反光', '扫描颗粒'],
    ),
    avoid: ['无版权来源的真实品牌拼贴', '素材随机堆砌', '低分辨率糊图', '文字不可读'],
    use_cases: ['编辑专题', '文化海报', '品牌故事', '社交长图'],
    density: 'high',
    emotional: 85,
  },
  {
    slug: 'op-art',
    name: '欧普艺术',
    english: 'Op Art',
    aliases: ['op art', 'optical art', '欧普', '视觉错觉', 'moire'],
    description: '利用重复图形、对比线条和视觉错觉制造闪烁、振动、膨胀与空间漂移感。',
    key_elements: ['重复线条', '视觉错觉', '黑白对比', '振动感'],
    color_palette: ['#000000', '#ffffff', '#ff4d6d', '#3a0ca3'],
    prompt_cues: cues(
      ['重复线阵', '透视扭曲', '中心旋涡', '错觉背景托住真实内容'],
      ['极简无衬线', '文字远离高频图案', '强留白标签'],
      ['平面印刷', '高反差纸面', '光学纹样'],
      ['黑白主导', '一个荧光强调'],
      ['缓慢相位移动', '波纹扩散', '低频避免眩晕'],
      ['锐利线条', '轻微纸纹', '边缘抗锯齿'],
    ),
    avoid: ['正文压在高频纹样上', '眩晕动画', '随机条纹', '无可访问性考虑'],
    use_cases: ['展览视觉', '动态背景', '音乐海报', '实验品牌'],
    density: 'high',
    emotional: 80,
  },
  {
    slug: 'conceptual',
    name: '概念艺术',
    english: 'Conceptual Art',
    aliases: ['conceptual', '概念', 'idea first', '命题', 'text based art'],
    description: '把观念、命题和语境置于成品外观之前，作品的核心价值更多来自思考机制本身。',
    key_elements: ['命题', '文字系统', '留白', '语境'],
    color_palette: ['#ffffff', '#111111', '#d9d9d9', '#8a817c'],
    prompt_cues: cues(
      ['一个清晰命题', '文档化结构', '留白和标注', '语境比装饰重要'],
      ['理性无衬线或等宽', '脚注式层级', '低调标题'],
      ['白纸', '档案纸', '标签', '展墙'],
      ['黑白灰', '语义色少量'],
      ['逐行显现', '标注连接', '冷静切换'],
      ['纸张边缘', '铅笔注记', '档案编号'],
    ),
    avoid: ['为了好看而装饰', '概念不可解释', '空洞哲学词', '视觉和命题脱节'],
    use_cases: ['研究展示', '展览文本', '品牌策略页', '数据叙事'],
    density: 'low',
    emotional: 70,
  },
  {
    slug: 'acid',
    name: '酸性设计',
    english: 'Acid Design',
    aliases: ['acid', 'acid graphics', '酸性', '荧光', 'liquid chrome'],
    description: '以高饱和荧光色、液态形变、金属质感和挑衅性排版制造强刺激、强数码感的视觉张力。',
    key_elements: ['荧光色', '液态形变', '金属质感', '挑衅排版'],
    color_palette: ['#ccff00', '#ff00ff', '#00ffff', '#111111'],
    prompt_cues: cues(
      ['液态形变主图', '大号挑衅标题', '层叠贴纸', '强反差黑底'],
      ['拉伸字体', '超粗或超窄字', '排版可实验但要可读'],
      ['液态金属', '铬面', '凝胶', '高光塑料'],
      ['荧光绿', '洋红', '电青', '黑底'],
      ['液体流动', '金属变形', '频闪但受控'],
      ['金属划痕', '液滴', '高光边', '微粒噪声'],
    ),
    avoid: ['全屏荧光无层级', '低俗夜店感', '文字变形不可读', '可访问性失败'],
    use_cases: ['潮流品牌', '音乐活动', '数字艺术', '实验海报'],
    density: 'high',
    emotional: 92,
  },
  {
    slug: 'color-field',
    name: '色域绘画',
    english: 'Color Field Painting',
    aliases: ['color field', '色域', '大色面', '沉浸色彩', 'rothko-like'],
    description: '用大面积纯色或近纯色关系营造沉浸式情绪场，让观看者直接进入色彩本身的心理空间。',
    key_elements: ['大色面', '微妙边界', '沉浸', '低图形'],
    color_palette: ['#264653', '#2a9d8f', '#e9c46a', '#f4f1de'],
    prompt_cues: cues(
      ['大块色域', '模糊边界', '少图形低噪声', '情绪分区'],
      ['极少文字', '细字重', '宽松行距'],
      ['画布纹理', '透明叠色', '柔和颜料边'],
      ['一到三块主色', '低对比过渡', '情绪色命名'],
      ['色块缓慢呼吸', '柔和溶解', '低速渐变'],
      ['画布纹', '颜料渗化', '微弱边缘颗粒'],
    ),
    avoid: ['花哨图标', '色块无情绪角色', '硬性 UI 控件混入背景', '单色无层次'],
    use_cases: ['沉浸页面', '冥想/音乐', '艺术品牌', '情绪海报'],
    density: 'low',
    emotional: 83,
  },
  {
    slug: 'naive',
    name: '稚拙艺术',
    english: 'Naive Art',
    aliases: ['naive art', 'naïve art', '稚拙', '童真', 'folk primitive'],
    description: '保留未经学院规训的直觉表达，常以平面化、童真感和朴素叙事传达真诚而直接的气息。',
    key_elements: ['平面化', '童真比例', '朴素叙事', '手绘感'],
    color_palette: ['#ffcad4', '#bde0fe', '#caffbf', '#fdffb6'],
    prompt_cues: cues(
      ['平面故事场景', '非学院比例', '手绘符号', '简单透视'],
      ['手写标题', '圆润字形', '少量标注'],
      ['蜡笔', '水粉', '纸张', '木刻感'],
      ['柔和糖果色', '民艺色块', '低阴影'],
      ['逐个出现', '纸偶移动', '轻快摇摆'],
      ['纸纹', '笔触边', '蜡笔颗粒'],
    ),
    avoid: ['幼稚低完成度', '商业 UI 过度儿童化', '比例错误影响产品识别', '假装粗糙'],
    use_cases: ['儿童教育', '手作品牌', '社区活动', '亲和插画'],
    density: 'medium',
    emotional: 89,
  },
  {
    slug: 'steampunk',
    name: '蒸汽朋克',
    english: 'Steampunk',
    aliases: ['steampunk', '蒸汽朋克', '维多利亚机械', 'brass gear', 'retro industrial'],
    description: '把维多利亚时代机械美学与假想蒸汽科技结合，形成复古、工业和冒险感兼具的世界观。',
    key_elements: ['黄铜', '齿轮', '皮革', '蒸汽机械'],
    color_palette: ['#2b2118', '#a97142', '#d6ad60', '#5c4033'],
    prompt_cues: cues(
      ['机械剖面', '仪表盘', '维多利亚框架', '冒险地图式布局'],
      ['复古衬线', '铭牌标签', '雕刻感数字'],
      ['黄铜', '皮革', '木材', '蒸汽管道'],
      ['棕金铜绿', '暖低饱和', '煤烟阴影'],
      ['齿轮啮合', '压力表指针', '蒸汽喷发'],
      ['铜锈', '皮革纹', '铆钉', '烟雾颗粒'],
    ),
    avoid: ['齿轮贴纸堆砌', '现代科幻材质混乱', '脏污影响可读', '伪历史刻板化'],
    use_cases: ['游戏 UI', '主题活动', '故事站点', '产品包装'],
    density: 'high',
    emotional: 84,
  },
  {
    slug: 'atompunk',
    name: '原子朋克',
    english: 'Atompunk',
    aliases: ['atompunk', '原子朋克', 'atomic age', 'mid-century futurism', 'raygun gothic'],
    description: '从20世纪中叶原子时代的乐观未来想象出发，以流线造型、核能意象和复古科技感构建世界。',
    key_elements: ['中世纪未来', '原子轨道', '流线', '复古科技'],
    color_palette: ['#f7f1d7', '#ff6f59', '#2ec4b6', '#1b1b3a'],
    prompt_cues: cues(
      ['原子轨道', '飞碟曲线', '星爆图形', '中世纪现代构图'],
      ['复古未来无衬线', '圆角字形', '乐观广告标题'],
      ['搪瓷', '铬金属', '彩色塑料', '玻璃仪表'],
      ['奶油底', '珊瑚橙', '蓝绿', '深海军蓝'],
      ['轨道旋转', '星爆闪现', '仪表扫动'],
      ['旧广告纸纹', '铬面划痕', '电视扫描颗粒'],
    ),
    avoid: ['核灾难废土误用', '现代赛博霓虹', '无时代感的通用复古', '符号太杂'],
    use_cases: ['复古科技品牌', '游戏界面', '展览视觉', '科普页面'],
    density: 'medium',
    emotional: 82,
  },
  {
    slug: 'cyberpunk',
    name: '赛博朋克',
    english: 'Cyberpunk',
    aliases: ['cyberpunk', '赛博朋克', '高科技低生活', 'neon noir', '雨夜霓虹'],
    description: '描绘高科技、低生活的城市未来，霓虹、网络、义体与社会失序共同构成压迫性的数字都市。',
    key_elements: ['霓虹', '雨夜', '网络层', '高科技低生活'],
    color_palette: ['#05010a', '#00f5d4', '#f15bb5', '#fee440'],
    prompt_cues: cues(
      ['雨夜城市层次', '屏幕密度', '街巷纵深', '人物/产品被霓虹勾边'],
      ['等宽或窄体技术字', '多语言标识少量', 'HUD 标签'],
      ['湿沥青', '玻璃', '金属义体', '电缆'],
      ['黑底青粉霓虹', '黄色警示点', '高反射'],
      ['霓虹闪烁', '雨滴滑落', 'HUD 扫描'],
      ['雨滴', '屏幕噪声', '金属划痕', '雾气'],
    ),
    avoid: ['只有霓虹没有社会/技术叙事', '文本过密', '暗到看不清', '低俗化人物'],
    use_cases: ['游戏/影视', '安全工具', '夜生活品牌', '科幻产品'],
    density: 'high',
    emotional: 91,
  },
  {
    slug: 'wasteland-punk',
    name: '废土朋克',
    english: 'Wasteland Punk',
    aliases: ['wasteland punk', '废土', 'post apocalyptic', 'scrap metal', 'survival'],
    description: '以文明崩坏后的生存景观为核心，强调改装、残破、尘土与资源匮乏下的野性秩序。',
    key_elements: ['残破金属', '尘土', '改装', '资源感'],
    color_palette: ['#2f2a23', '#8d6e63', '#c2b280', '#b23a48'],
    prompt_cues: cues(
      ['低地平线', '改装结构', '资源清单式 UI', '粗粝环境纵深'],
      ['军用模板字', '磨损标签', '喷漆标记'],
      ['锈铁', '帆布', '橡胶', '尘土'],
      ['沙土棕', '锈红', '褪色军绿', '低饱和'],
      ['尘雾推进', '机械震动', '布料受风'],
      ['锈迹', '划痕', '灰尘', '破布纤维'],
    ),
    avoid: ['无意义脏污', '界面不可读', '现代干净材质混入', '暴力血腥默认化'],
    use_cases: ['游戏', '电影概念', '户外装备', '末日叙事页面'],
    density: 'high',
    emotional: 86,
  },
  {
    slug: 'vaporwave',
    name: '蒸汽波美学',
    english: 'Vaporwave Aesthetics',
    aliases: ['vaporwave', '蒸汽波', 'mallsoft', 'retro web', '90s web'],
    description: '借用90年代商业图像、早期数字界面和怀旧消费符号，制造虚拟、空心又迷离的时代表层感。',
    key_elements: ['90年代界面', '网格地平线', '雕塑', '怀旧消费'],
    color_palette: ['#ff71ce', '#01cdfe', '#b967ff', '#f8f8ff'],
    prompt_cues: cues(
      ['网格地平线', '漂浮古典雕塑', '旧界面窗口', '虚拟商场空间'],
      ['早期网页字体', '全角字距感', '像素标签'],
      ['低多边形 CGI', '塑料植物', '大理石雕塑', 'CRT 屏'],
      ['粉青紫渐变', '霓虹柔光', '低保真高亮'],
      ['慢速漂浮', 'VHS 扫描', '窗口层叠'],
      ['VHS 噪声', '像素边', '压缩痕迹', '光晕'],
    ),
    avoid: ['只放粉紫渐变', '真实品牌 logo 滥用', '怀旧符号无观点', '文字乱码过多'],
    use_cases: ['音乐视觉', '复古专题', '数字艺术', '潮流页面'],
    density: 'medium',
    emotional: 88,
  },
  {
    slug: 'y2k',
    name: 'Y2K千禧美学',
    english: 'Y2K Aesthetics',
    aliases: ['y2k', '千禧', 'cyber y2k', 'chromecore', '透明塑料'],
    description: '汇集千禧年前后对数字未来的想象，常见金属光泽、透明塑料、气泡字体与乐观科技感。',
    key_elements: ['银色金属', '透明塑料', '气泡字体', '乐观科技'],
    color_palette: ['#d9e4ff', '#b8f7ff', '#c0c0c0', '#ff9cee'],
    prompt_cues: cues(
      ['圆润未来物体', '透明外壳', '早期 3D 图标', '浮动胶囊 UI'],
      ['气泡字', '圆角科技字', '金属标题'],
      ['铬金属', '透明彩色塑料', '凝胶', '全息贴膜'],
      ['冰蓝银白', '粉紫点缀', '亮面渐变'],
      ['气泡浮动', '铬面扫光', '透明层折射'],
      ['塑料划痕', '高光边', '微小气泡', '像素装饰'],
    ),
    avoid: ['McBling 误用到低俗', '透明层导致文字不可读', '全息过量', '只做怀旧无产品语义'],
    use_cases: ['潮流电商', '音乐/时尚', '消费电子', '社交视觉'],
    density: 'medium',
    emotional: 86,
  },
  {
    slug: 'solarpunk',
    name: '太阳朋克',
    english: 'Solarpunk',
    aliases: ['solarpunk', '太阳朋克', '生态未来', 'renewable', 'green tech'],
    description: '设想生态技术与社区协作共生的未来，画面常充满太阳能、绿植、开放结构与温和的乐观气质。',
    key_elements: ['太阳能', '绿植', '开放结构', '生态科技'],
    color_palette: ['#fefae0', '#606c38', '#dda15e', '#2a9d8f'],
    prompt_cues: cues(
      ['开放式建筑', '绿植与技术共生', '社区尺度', '阳光通风构图'],
      ['友好无衬线', '可读标签', '温和信息层级'],
      ['太阳能板', '木材', '玻璃温室', '植物纤维'],
      ['暖日光', '叶绿', '陶土', '清水蓝'],
      ['叶影摇动', '光斑移动', '风驱动结构'],
      ['叶脉', '木纹', '太阳能板细格', '空气微尘'],
    ),
    avoid: ['空洞乌托邦', '绿植贴图堆砌', '忽略可用性', '把生态做成低科技贫乏'],
    use_cases: ['可持续品牌', '城市/建筑', '教育公益', '绿色科技'],
    density: 'medium',
    emotional: 90,
  },
  {
    slug: 'kidcore',
    name: '童核美学',
    english: 'Kidcore Aesthetics',
    aliases: ['kidcore', '童核', 'toy colors', 'classroom nostalgia', '糖果玩具'],
    description: '调用儿童时代的玩具、糖果色、卡通图形与教室符号，唤起明亮却略带失真的怀旧感。',
    key_elements: ['糖果色', '玩具符号', '贴纸', '初级图形'],
    color_palette: ['#ffbe0b', '#ff006e', '#8338ec', '#3a86ff'],
    prompt_cues: cues(
      ['玩具箱式陈列', '贴纸层', '初级几何', '儿童记忆符号'],
      ['圆润大字', '贴纸标题', '低年龄感需控制'],
      ['塑料玩具', '蜡笔', '贴纸纸面', '橡皮泥'],
      ['糖果原色', '高饱和但分区', '白底缓冲'],
      ['贴纸弹入', '玩具摆动', '轻快节拍'],
      ['塑料划痕', '蜡笔颗粒', '贴纸边缘', '纸屑'],
    ),
    avoid: ['目标用户不匹配时幼稚化', '低龄化误伤高端品牌', '色彩失控', '图标含义不清'],
    use_cases: ['儿童教育', '玩具/糖果', '怀旧活动', '社交视觉'],
    density: 'high',
    emotional: 89,
  },
  {
    slug: 'dreamcore',
    name: '梦核美学',
    english: 'Dreamcore Aesthetics',
    aliases: ['dreamcore', '梦核', 'liminal', 'weirdcore', '空旷梦境'],
    description: '通过空旷场所、低逻辑叙事、模糊记忆与梦境式氛围激发熟悉却无法落地的不安与迷失。',
    key_elements: ['空旷空间', '低逻辑', '记忆模糊', '梦境氛围'],
    color_palette: ['#f4f1de', '#a7c7e7', '#cdb4db', '#6d6875'],
    prompt_cues: cues(
      ['空旷熟悉空间', '孤立物体', '低逻辑路径', '大量环境留白'],
      ['少量短句', '像记忆碎片', '低声量排版'],
      ['旧地毯', '荧光灯', '雾面墙', '玩具或门框'],
      ['褪色粉蓝紫', '病态暖白', '低对比阴影'],
      ['缓慢漂移', '轻微视差', '空间无声变形'],
      ['柔焦', '低清晰颗粒', '荧光灯闪烁', '旧墙污渍'],
    ),
    avoid: ['恐怖 jump scare', '无意义怪诞', '过多文字', '商业产品识别被梦境吞掉'],
    use_cases: ['音乐视觉', '叙事页面', '实验影像', '艺术项目'],
    density: 'medium',
    emotional: 91,
  },
];

function makeStyle(preset: StylePreset): DesignStyle {
  const densitySettings = {
    low: { spacing: '宽松', maxWidth: '960px', negativeSpace: '大量留白' },
    medium: { spacing: '节奏化', maxWidth: '1180px', negativeSpace: '可控留白' },
    high: { spacing: '紧凑分层', maxWidth: '1280px', negativeSpace: '局部留白' },
  }[preset.density];

  return {
    name: preset.name,
    english: preset.english,
    aliases: [...new Set([preset.name, preset.english, ...preset.aliases])],
    description: preset.description,
    key_elements: preset.key_elements,
    color_palette: preset.color_palette,
    prompt_cues: preset.prompt_cues,
    avoid: preset.avoid,
    use_cases: preset.use_cases,
    typography: {
      headings: preset.density === 'high' ? '高对比标题，允许实验性字重' : '清晰标题，强调比例和层级',
      body: '可读性优先，正文不得低于可访问尺寸',
      weight: preset.density === 'low' ? ['300', '400', '600'] : ['400', '600', '800'],
      spacing: preset.density === 'high' ? '紧密但不重叠' : '舒展',
      lineHeight: preset.density === 'high' ? '1.35' : '1.55',
    },
    layout: {
      grid: preset.density === 'high' ? '多层网格，明确主次' : '稳定网格，强调对齐',
      spacing: densitySettings.spacing,
      maxWidth: densitySettings.maxWidth,
      alignment: preset.density === 'high' ? '非对称时仍保持视觉锚点' : '清晰对齐',
      negativeSpace: densitySettings.negativeSpace,
    },
    compatibility: {
      technical: preset.english.includes('Glitch') || preset.english.includes('Acid') ? 78 : 88,
      visual: 90,
      functional: preset.density === 'high' ? 78 : 90,
      emotional: preset.emotional,
      practical: preset.density === 'high' ? 76 : 88,
    },
  };
}

export const DESIGN_STYLES: Record<string, DesignStyle> = Object.fromEntries(
  STYLE_PRESETS.map(preset => [preset.slug, makeStyle(preset)]),
) as Record<string, DesignStyle>;

export const ALL_STYLES = Object.values(DESIGN_STYLES);

function normalizeStyleText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function scoreDesignStyle(style: DesignStyle, input: string): number {
  const normalizedInput = normalizeStyleText(input);
  let score = 0;

  for (const alias of style.aliases) {
    if (normalizedInput.includes(normalizeStyleText(alias))) {
      score += alias.length > 5 ? 6 : 4;
    }
  }

  for (const cue of [...style.key_elements, ...style.prompt_cues.composition, ...style.prompt_cues.materiality]) {
    if (normalizedInput.includes(normalizeStyleText(cue))) {
      score += 2;
    }
  }

  return score;
}

export function findDesignStyles(input: string, maxResults = 2): DesignStyle[] {
  const ranked = ALL_STYLES
    .map(style => ({ style, score: scoreDesignStyle(style, input) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.style.name.localeCompare(right.style.name));

  return ranked.slice(0, maxResults).map(entry => entry.style);
}

export function formatDesignStyleForPrompt(style: DesignStyle): string {
  return [
    `${style.name} / ${style.english}: ${style.description}`,
    `  key=${style.key_elements.join(', ')}`,
    `  composition=${style.prompt_cues.composition.slice(0, 3).join(', ')}`,
    `  material=${style.prompt_cues.materiality.slice(0, 3).join(', ')}`,
    `  color=${style.prompt_cues.color.slice(0, 3).join(', ')}`,
    `  avoid=${style.avoid.slice(0, 3).join(', ')}`,
  ].join('\n');
}
