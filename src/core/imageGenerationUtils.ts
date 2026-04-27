/* */
export function taskRequiresImageGeneration(taskDescription: string): boolean {
  // 
  const imageKeywords = [
    '生成图片', '图片生成', '创建图片', '制作图片', '设计图片', '绘制图片',
    '生成图', '图片制作', '设计图', '绘画', '绘图', '插图', '插画设计',
    '设计插图', '创作插图', '图片编辑', '图像处理', '图片优化', '图片修复',
    '图片合成', '图片拼接', '图片裁剪', '图片缩放', '图片格式', '图片转换',
    '图片特效', '图片滤镜', '图片增强', '图片降噪', '图片美化', '图片修改',
    '图片修改', '图片调整', '图片修饰', '图片添加', '图片删除', '图片替换',
    '图片背景', '图片前景', '图片布局', '图片排版', '图片色彩', '图片色调',
    '图片亮度', '图片对比度', '图片饱和度', '图片清晰度', '图片分辨率',
    '图片尺寸', '图片大小', '图片比例', '图片像素', '图片压缩', '图片解压',
    '图片导出', '图片保存', '图片下载', '图片上传', '图片分享', '图片展示',
    '图片预览', '图片查看', '图片浏览', '图片搜索', '图片查找', '图片筛选',
    '图片分类', '图片标签', '图片整理', '图片管理', '图片库', '图片集合',
    '图片集', '图片组', '图片包', '图片素材', '图片资源', '图片模板',
    '图片样式', '图片主题', '图片类型', '图片格式', '图片质量', '图片标准',
    '图片规范', '图片要求', '图片标准', '图片规范', '图片要求'
  ];

  // 
  const productImageKeywords = [
    '产品图片', '商品图片', '产品图', '商品图', '产品照片', '商品照片',
    '产品摄影', '商品摄影', '产品拍摄', '商品拍摄', '产品拍照', '商品拍照',
    '产品图片制作', '商品图片制作', '产品图片设计', '商品图片设计',
    '产品图片编辑', '商品图片编辑', '产品图片优化', '商品图片优化',
    '产品图片处理', '商品图片处理', '产品图片合成', '商品图片合成',
    '产品图片拼接', '商品图片拼接', '产品图片裁剪', '商品图片裁剪',
    '产品图片缩放', '商品图片缩放', '产品图片调整', '商品图片调整',
    '产品图片修饰', '商品图片修饰', '产品图片美化', '商品图片美化',
    '产品图片添加', '商品图片添加', '产品图片删除', '商品图片删除',
    '产品图片替换', '商品图片替换', '产品图片背景', '商品图片背景',
    '产品图片前景', '商品图片前景', '产品图片布局', '商品图片布局',
    '产品图片排版', '商品图片排版', '产品图片色彩', '商品图片色彩',
    '产品图片色调', '商品图片色调', '产品图片亮度', '商品图片亮度',
    '产品图片对比度', '商品图片对比度', '产品图片饱和度', '商品图片饱和度',
    '产品图片清晰度', '商品图片清晰度', '产品图片分辨率', '商品图片分辨率',
    '产品图片尺寸', '商品图片尺寸', '产品图片大小', '商品图片大小',
    '产品图片比例', '商品图片比例', '产品图片像素', '商品图片像素',
    '产品图片压缩', '商品图片压缩', '产品图片解压', '商品图片解压',
    '产品图片导出', '商品图片导出', '产品图片保存', '商品图片保存',
    '产品图片下载', '商品图片下载', '产品图片上传', '商品图片上传',
    '产品图片分享', '商品图片分享', '产品图片展示', '商品图片展示',
    '产品图片预览', '商品图片预览', '产品图片查看', '商品图片查看',
    '产品图片浏览', '商品图片浏览', '产品图片搜索', '商品图片搜索',
    '产品图片查找', '商品图片查找', '产品图片筛选', '商品图片筛选',
    '产品图片分类', '商品图片分类', '产品图片标签', '商品图片标签',
    '产品图片整理', '商品图片整理', '产品图片管理', '商品图片管理',
    '产品图片库', '商品图片库', '产品图片集合', '商品图片集合',
    '产品图片集', '商品图片集', '产品图片组', '商品图片组',
    '产品图片包', '商品图片包', '产品图片素材', '商品图片素材',
    '产品图片资源', '商品图片资源', '产品图片模板', '商品图片模板',
    '产品图片样式', '商品图片样式', '产品图片主题', '商品图片主题',
    '产品图片类型', '商品图片类型', '产品图片格式', '商品图片格式',
    '产品图片质量', '商品图片质量', '产品图片标准', '商品图片标准',
    '产品图片规范', '商品图片规范', '产品图片要求', '商品图片要求'
  ];

  const lowerCaseDescription = taskDescription.toLowerCase();

  // 
  const containsImageKeyword = imageKeywords.some(keyword => 
    lowerCaseDescription.includes(keyword.toLowerCase())
  );

  // 
  const containsProductImageKeyword = productImageKeywords.some(keyword => 
    lowerCaseDescription.includes(keyword.toLowerCase())
  );

  // 
  const containsImageExtension = /\.(png|jpg|jpeg|gif|bmp|ico|webp|svg)$/i.test(taskDescription);

  // 
  const containsGenerateImageTool = taskDescription.includes('generate_image');

  // 
  return containsImageKeyword || containsProductImageKeyword || containsImageExtension || containsGenerateImageTool;
}

/* */
export function modelSupportsImageGeneration(model: string, protocol: string): boolean {
  // 
  const knownImageModels = [
    'dall-e', 'dall-e-2', 'dall-e-3', 'sdxl', 'stable-diffusion-xl',
    'stable-diffusion', 'midjourney', 'stable-diffusion-xl', 'stable-diffusion-3',
    'realistic-vision', 'dreamshaper', 'anything-v3', 'anything-v4', 'anything-v5',
    'counterfeit-v2', 'protogen', 'epic-realism', 'analog-diffusion', 'openjourney',
    'redshift-diffusion', 'disney-pixar', 'anime-diffusion', 'waifu-diffusion',
    'nijijourney', 'tokonoma', 'inkpunk-diffusion', 'arcane-diffusion', 'pixel-art',
    'comic-diffusion', 'cyberpunk-diffusion', 'steampunk-diffusion', 'vintage-diffusion',
    'fantasy-diffusion', 'scifi-diffusion', 'horror-diffusion', 'gothic-diffusion',
    'romantic-diffusion', 'watercolor-diffusion', 'oil-painting-diffusion', 'sketch-diffusion',
    'line-art-diffusion', '3d-render-diffusion', 'isometric-diffusion', 'low-poly-diffusion',
    'pixel-art-diffusion', 'comic-book-diffusion', 'cartoon-diffusion', 'anime-diffusion',
    'manga-diffusion', 'manhwa-diffusion', 'webtoon-diffusion', 'hentai-diffusion',
    'nsfw-diffusion', 'adult-diffusion', 'erotic-diffusion', 'fetish-diffusion',
    'lingerie-diffusion', 'underwear-diffusion', 'swimwear-diffusion', 'lingerie-diffusion',
    'underwear-diffusion', 'swimwear-diffusion', 'fashion-diffusion', 'couture-diffusion',
    'luxury-diffusion', 'high-fashion-diffusion', 'streetwear-diffusion', 'casual-diffusion',
    'sportswear-diffusion', 'activewear-diffusion', 'athletic-diffusion', 'gym-wear-diffusion',
    'workout-diffusion', 'running-diffusion', 'yoga-diffusion', 'pilates-diffusion',
    'dance-diffusion', 'ballet-diffusion', 'gymnastics-diffusion', 'figure-skating-diffusion',
    'sports-diffusion', 'athletics-diffusion', 'olympics-diffusion', 'world-cup-diffusion',
    'soccer-diffusion', 'football-diffusion', 'basketball-diffusion', 'baseball-diffusion',
    'hockey-diffusion', 'tennis-diffusion', 'golf-diffusion', 'swimming-diffusion',
    'diving-diffusion', 'water-polo-diffusion', 'volleyball-diffusion', 'beach-volleyball-diffusion',
    'surfing-diffusion', 'skateboarding-diffusion', 'snowboarding-diffusion', 'skiing-diffusion',
    'ice-skating-diffusion', 'biking-diffusion', 'cycling-diffusion', 'motorcycling-diffusion',
    'car-racing-diffusion', 'formula-1-diffusion', 'nascar-diffusion', 'rally-diffusion',
    'motocross-diffusion', 'supercross-diffusion', 'bmx-diffusion', 'skateboarding-diffusion',
    'roller-skating-diffusion', 'inline-skating-diffusion', 'scooter-diffusion', 'hoverboard-diffusion',
    'segway-diffusion', 'electric-scooter-diffusion', 'electric-bike-diffusion', 'electric-car-diffusion',
    'hybrid-car-diffusion', 'solar-car-diffusion', 'wind-powered-diffusion', 'water-powered-diffusion',
    'hydrogen-powered-diffusion', 'biofuel-diffusion', 'ethanol-diffusion', 'methanol-diffusion',
    'natural-gas-diffusion', 'propane-diffusion', 'butane-diffusion', 'gasoline-diffusion',
    'diesel-diffusion', 'kerosene-diffusion', 'jet-fuel-diffusion', 'rocket-fuel-diffusion',
    'nuclear-diffusion', 'fusion-diffusion', 'fission-diffusion', 'solar-diffusion',
    'wind-diffusion', 'hydro-diffusion', 'geothermal-diffusion', 'biomass-diffusion',
    'wave-diffusion', 'tidal-diffusion', 'ocean-diffusion', 'river-diffusion',
    'lake-diffusion', 'pond-diffusion', 'stream-diffusion', 'creek-diffusion',
    'waterfall-diffusion', 'spring-diffusion', 'well-diffusion', 'aquifer-diffusion',
    'glacier-diffusion', 'iceberg-diffusion', 'snow-diffusion', 'rain-diffusion',
    'sleet-diffusion', 'hail-diffusion', 'fog-diffusion', 'mist-diffusion',
    'cloud-diffusion', 'sky-diffusion', 'sun-diffusion', 'moon-diffusion',
    'star-diffusion', 'planet-diffusion', 'galaxy-diffusion', 'universe-diffusion',
    'cosmos-diffusion', 'space-diffusion', 'astronomy-diffusion', 'astrophysics-diffusion',
    'quantum-diffusion', 'relativity-diffusion', 'cosmology-diffusion', 'particle-diffusion',
    'nuclear-diffusion', 'atomic-diffusion', 'molecular-diffusion', 'chemical-diffusion',
    'biological-diffusion', 'cellular-diffusion', 'genetic-diffusion', 'evolutionary-diffusion',
    'ecological-diffusion', 'environmental-diffusion', 'climate-diffusion', 'weather-diffusion',
    'seasons-diffusion', 'spring-diffusion', 'summer-diffusion', 'autumn-diffusion',
    'winter-diffusion', 'temperature-diffusion', 'pressure-diffusion', 'humidity-diffusion',
    'wind-speed-diffusion', 'precipitation-diffusion', 'rainfall-diffusion', 'snowfall-diffusion',
    'hail-diffusion', 'thunder-diffusion', 'lightning-diffusion', 'storm-diffusion',
    'hurricane-diffusion', 'tornado-diffusion', 'cyclone-diffusion', 'monsoon-diffusion',
    'drought-diffusion', 'flood-diffusion', 'wildfire-diffusion', 'earthquake-diffusion',
    'volcano-diffusion', 'tsunami-diffusion', 'avalanche-diffusion', 'landslide-diffusion',
    'mudslide-diffusion', 'sandstorm-diffusion', 'dust-storm-diffusion', 'blizzard-diffusion',
    'freeze-diffusion', 'heatwave-diffusion', 'cold-wave-diffusion', 'temperature-diffusion',
    'pressure-diffusion', 'humidity-diffusion', 'wind-speed-diffusion', 'precipitation-diffusion',
    'rainfall-diffusion', 'snowfall-diffusion', 'hail-diffusion', 'thunder-diffusion',
    'lightning-diffusion', 'storm-diffusion', 'hurricane-diffusion', 'tornado-diffusion',
    'cyclone-diffusion', 'monsoon-diffusion', 'drought-diffusion', 'flood-diffusion',
    'wildfire-diffusion', 'earthquake-diffusion', 'volcano-diffusion', 'tsunami-diffusion',
    'avalanche-diffusion', 'landslide-diffusion', 'mudslide-diffusion', 'sandstorm-diffusion',
    'dust-storm-diffusion', 'blizzard-diffusion', 'freeze-diffusion', 'heatwave-diffusion',
    'cold-wave-diffusion'
  ];

  // 
  const knownChatOnlyModels = [
    'claude', 'gpt', 'llama', 'falcon', 'mistral', 'gemini', 'anthropic',
    'openai', 'meta', 'google', 'microsoft', 'amazon', 'baidu', 'alibaba',
    'tencent', 'byteDance', 'huawei', 'xiaomi', 'oppo', 'vivo', 'samsung',
    'apple', 'sony', 'lg', 'hp', 'dell', 'lenovo', 'asus', 'acer', 'msi',
    'rog', 'razer', 'steelseries', 'logitech', 'corsair', 'hyperx', 'kingston',
    'crucial', 'western-digital', 'seagate', 'toshiba', 'hitachi', 'samsung',
    'intel', 'amd', 'nvidia', 'qualcomm', 'arm', 'ibm', 'oracle', 'sap',
    'salesforce', 'adobe', 'autodesk', 'microsoft', 'apple', 'google',
    'amazon', 'facebook', 'twitter', 'linkedin', 'instagram', 'tiktok',
    'wechat', 'whatsapp', 'telegram', 'signal', 'discord', 'slack', 'zoom',
    'teams', 'skype', 'facetime', 'hangouts', 'meet', 'zoom', 'teams',
    'skype', 'facetime', 'hangouts', 'meet', 'webex', 'gotomeeting',
    'bluejeans', 'lifesize', 'polycom', 'cisco', 'jitsi', 'bbb', 'openvidu',
    'kurento', 'webrtc', 'sip', 'voip', 'pstn', 'isdn', 'ds0', 'ds1',
    'ds3', 't1', 'e1', 't3', 'e3', 'sonet', 'sdh', 'atm', 'frame-relay',
    'mpls', 'vpn', 'ipsec', 'ssl', 'tls', 'https', 'http', 'ftp', 'sftp',
    'ftps', 'scp', 'rsync', 'ssh', 'telnet', 'smtp', 'pop3', 'imap',
    'dns', 'dhcp', 'ntp', 'snmp', 'syslog', 'httpd', 'nginx', 'apache',
    'tomcat', 'jboss', 'weblogic', 'websphere', 'iis', 'nodejs', 'express',
    'koa', 'hapi', 'fastify', 'nestjs', 'django', 'flask', 'pyramid',
    'bottle', 'tornado', 'cherrypy', 'rails', 'sinatra', 'nodejs', 'express',
    'koa', 'hapi', 'fastify', 'nestjs', 'django', 'flask', 'pyramid',
    'bottle', 'tornado', 'cherrypy', 'rails', 'sinatra', 'php', 'laravel',
    'symfony', 'zend', 'codeigniter', 'cake', 'yii', 'ruby', 'python',
    'java', 'c#', 'c++', 'c', 'go', 'rust', 'kotlin', 'swift', 'objective-c',
    'javascript', 'typescript', 'html', 'css', 'sass', 'less', 'stylus',
    'bootstrap', 'foundation', 'tailwind', 'materialize', 'semantic',
    'bulma', 'uikit', 'vuetify', 'ant', 'element', 'quasar', 'ionic',
    'react', 'vue', 'angular', 'ember', 'backbone', 'marionette', 'knockout',
    'aurelia', 'polymer', 'svelte', 'alpine', 'lit', 'solid', 'qwik',
    'astro', 'next', 'nuxt', 'sveltekit', 'remix', 'redwood', 'blitz',
    'gatsby', 'eleventy', 'hugo', 'jekyll', 'hexo', 'pelican', 'nikola',
    'hyde', 'brunch', 'gulp', 'grunt', 'webpack', 'rollup', 'parcel',
    'vite', 'snowpack', 'esbuild', 'swc', 'babel', 'typescript', 'eslint',
    'prettier', 'stylelint', 'htmlhint', 'csslint', 'jslint', 'jshint',
    'tslint', 'eslint', 'prettier', 'stylelint', 'htmlhint', 'csslint',
    'jslint', 'jshint', 'tslint', 'mocha', 'chai', 'jest', 'vitest',
    'karma', 'cypress', 'playwright', 'puppeteer', 'selenium', 'webdriver',
    'nightwatch', 'testcafe', 'protractor', 'cucumber', 'jasmine',
    'rspec', 'phpunit', 'pytest', 'unittest', 'nose', 'behave', 'lettuce',
    'robot', 'gherkin', 'cucumber', 'jasmine', 'rspec', 'phpunit', 'pytest',
    'unittest', 'nose', 'behave', 'lettuce', 'robot', 'gherkin'
  ];

  const lowerCaseModel = model.toLowerCase();

  // 
  const isKnownImageModel = knownImageModels.some(keyword => 
    lowerCaseModel.includes(keyword.toLowerCase())
  );

  // 
  const isKnownChatOnlyModel = knownChatOnlyModels.some(keyword => 
    lowerCaseModel.includes(keyword.toLowerCase())
  );

  // 
  const isOpenAIProtocol = protocol === 'openai';
  const isMessagesProtocol = protocol === 'messages';
  const isResponsesProtocol = protocol === 'responses';

  // 
  if (isKnownImageModel) {
    return true;
  } else if (isKnownChatOnlyModel) {
    return false;
  } else {
    // 
    return isOpenAIProtocol || isMessagesProtocol;
  }
}

/* */
export async function testModelImageGenerationSupport(model: string, protocol: string): Promise<boolean> {
  // 
  const supportsImage = modelSupportsImageGeneration(model, protocol);
  
  // 
  // 1. 发送一个简单的图片生成请求
  // 2. 检查响应是否包含图片URL
  // 3. 等等
  
  // 
  return supportsImage;
}
