#!/usr/bin/env node
/**
 * 30 秒 Saga 长视频测试：夜晚海边，灯红酒绿，纸醉金迷。
 *
 * 运行方式：
 *   cd /Users/goat/AntiClaude/Artemis\ Code
 *   node --no-warnings node_modules/tsx/dist/cli.mjs run-night-beach-test.mjs
 *
 * 说明：
 * - 使用 character-turnaround.png 作为全局角色身份参考，而不是首帧占位图。
 * - 直接调用 Artemis 的 generate_long_video/Saga 管线，避免落入单段 generate_video 的 15s 限制。
 * - 四个镜头各 7.5 秒，总计 30 秒；每段低于 Seedance 单段时长上限。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeGenerateLongVideo } from './src/tools/generateLongVideo.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = __dirname;

const TURNAROUND_PATH = '/Users/goat/.artemis/generated-media/long-videos/saga-pokerroom-1778245275747/super-visual/character-turnaround.png';
const TOTAL_DURATION = 30;
const PROJECT_ID = 'saga-night-beach-turnaround-test';
const TITLE = '霓虹海岸夜宴';

if (!existsSync(TURNAROUND_PATH)) {
  console.error(`Missing character turnaround reference: ${TURNAROUND_PATH}`);
  process.exit(1);
}

const story = `
基于给定三视图 character-turnaround.png 制作 30 秒长视频测试。
主角必须始终来源于并保持三视图中的同一角色身份、服装轮廓、发型/头部轮廓、体态比例和整体设计语言。
场景为夜晚海边：暗色海面、湿沙、海岸线、海边酒吧、游艇远灯、霓虹红绿灯牌、玻璃与金属反光、香槟和奢华夜生活氛围共同组成灯红酒绿、纸醉金迷的夜宴。
整体为电影感写实输出，Arri Alexa LogC，16:9，30fps，强霓虹反射，海风持续推动头发和衣物，海浪只在岸线和脚踝附近发生物理接触。
`.trim();

const shots = [
  {
    title: '霓虹入场',
    duration: 7.5,
    storyBeat:
      '0–2s: 主角沿湿沙海岸步入画面，脚掌真实接触沙地，远处海浪在岸线滚动；霓虹红绿光在湿沙上闪烁。2–5s: 主角转过上身穿过海边酒吧外溢的彩色灯束，头发和衣物被海风吹动；玻璃灯饰和远处游艇灯缓慢摇晃。5–end: 主角抬起手臂挡过一束红色霓虹，继续向镜头侧前方移动，脚边只有浪花抵达时才出现轻微水光。',
    visualPrompt:
      'Opening frame: the same character from the turnaround image enters from frame left on a wet nighttime beach, dark ocean behind, saturated red and green neon from a seaside club reflecting on wet sand. Keep the character identity locked to character-turnaround.png: same silhouette, outfit design, head shape, hair/wardrobe cues, and proportions. Decadent glamorous seaside nightlife, champagne-colored bokeh, yacht lights, no extra lead characters, cinematic live-action texture, ray-traced reflections, volumetric neon haze, dark ocean blue palette.',
    camera:
      '35mm lens, low gimbal tracking shot moving backward at walking speed, slight parallax between protagonist, neon bar lights, and dark ocean; Arri Alexa LogC, subtle handheld energy.',
    continuity:
      '主角三视图身份全局锁定；夜晚海边、红绿霓虹、湿沙反光和暗色海面贯穿。主角是视觉中心，夜生活元素只做环境承托。',
    transition:
      'Closing frame: 主角手臂掠过红色霓虹灯束，红光擦过镜头形成一条横向光带，带入下一镜头的吧台玻璃反光。',
    transitionKind: 'shader-light-leak',
  },
  {
    title: '海边吧台反光',
    duration: 7.5,
    storyBeat:
      '0–2s: 主角从红色光带中走近海边露天吧台，手指掠过不接触身体的金属栏杆；吧台玻璃反射红绿灯光。2–5s: 主角伸手拿起一只装有金色饮品的高脚杯，杯底稳定离开吧台，液体随动作轻微晃动但不飞溅；海风推动吊灯和薄雾。5–end: 主角带着杯子侧身经过镜头，肩部和衣物轮廓保持与三视图一致，背景暗海和游艇灯从玻璃反射中滑过。',
    visualPrompt:
      'Opening frame: the previous red neon streak resolves into a glossy seaside bar counter reflection, and the same turnaround character approaches as the dominant subject. Night beach luxury: crystal glass, chrome rails, red-green neon signage, champagne glints, dark ocean visible beyond the bar canopy. The character keeps the exact identity and wardrobe silhouette from character-turnaround.png; props never replace the character as subject. Physical glass reflections follow surface geometry; no floating objects, no body-object intersections.',
    camera:
      '50mm lens, smooth dolly-in then short side-track past the protagonist, shallow depth of field, anamorphic bokeh, reflective close-medium framing without turning the drink into the subject.',
    continuity:
      '承接上一镜头红色光带；主角仍在同一夜晚海边夜生活场景，霓虹红绿反射、暗海背景、海风运动持续。',
    transition:
      'Closing frame: 高脚杯中的绿色霓虹倒影随着主角移动变成一道弧形绿光，弧光方向匹配下一镜头海岸步道灯串。',
    transitionKind: 'match-cut',
  },
  {
    title: '灯串下的潮线',
    duration: 7.5,
    storyBeat:
      '0–2s: 主角沿海岸步道灯串下继续移动，手中杯子自然下垂在身体一侧；灯串和棕榈影在风中轻晃。2–5s: 主角踏下台阶回到湿沙边缘，脚落在可行走地面，远处浪线推进但只在接近脚边时形成细小涟漪；衣物随转身展开。5–end: 主角转身让霓虹从背后勾出轮廓，向海面方向迈出一步又停在安全潮线外，红绿反光在脚前湿沙延伸。',
    visualPrompt:
      'Opening frame: the green arc from the drink becomes a row of green-and-red string lights along a lavish seaside walkway; the same character from the turnaround image moves under them. The dark ocean remains spatially separated from sand and walkway. Wet sand mirror reflections, palm silhouettes, velvet-rope beach lounge, distant club smoke, decadent nightlife glow. Preserve exact character identity, body proportions, clothing silhouette, and head/hair design from the three-view reference.',
    camera:
      '35mm lens, crane-down into a gimbal arc around the protagonist, active parallax from string lights to tide line, cinematic motion blur, high-contrast neon rim light.',
    continuity:
      '绿色弧光接成灯串；主角、三视图服装轮廓、夜晚海边、红绿反射、湿沙和暗海连续。海水只影响真实接触的岸线区域。',
    transition:
      'Closing frame: 主角背后红绿轮廓光和脚前湿沙反光汇聚成一条明亮纵深线，下一镜头从同一纵深线推向最终海岸夜宴。',
    transitionKind: 'push-left',
  },
  {
    title: '纸醉金迷终章',
    duration: 7.5,
    storyBeat:
      '0–2s: 主角沿上一镜头的湿沙反光线向海边灯光中心走去，海风持续推动衣物和发丝；背景灯牌闪烁。2–5s: 主角转身面向霓虹海岸线，抬起杯子让红绿光掠过杯壁和脸部轮廓，杯中液体因手部运动轻微晃动但不溢出。5–end: 主角缓慢放下杯子并向镜头迈近半步，暗海、游艇灯、海边酒吧和湿沙反光同时收束到主角身上，形成最强烈的灯红酒绿终章。',
    visualPrompt:
      'Opening frame: a bright wet-sand perspective line from the previous shot leads directly to the same locked-identity character at the center of a neon-soaked seaside night party. Final memorable beat: decadent red and green club lights, dark ocean horizon, yacht bokeh, reflective wet sand, glass and chrome highlights, luxurious but grounded nightlife. The character remains the dominant visual center, same turnaround identity and wardrobe silhouette, cinematic live-action finish, volumetric haze, ray-traced reflections, no morphing, no identity drift.',
    camera:
      '50mm to 70mm slow dolly-in, slight snorricam-like stabilization around the protagonist for the final half-step, IMAX 70mm grain, polished neon contrast, controlled lens flare.',
    continuity:
      '从湿沙纵深线进入终章；主角身份与夜晚海边灯红酒绿氛围完整闭环。最终镜头把环境奢华感收束回主角。',
    transition:
      'Closing frame: 主角放下杯子后向镜头迈近，红绿霓虹和暗海反光在其轮廓周围收束，画面自然淡入黑场。',
    transitionKind: 'cinematic-fade',
  },
];

const narrativeEntities = {
  protagonist: {
    name: '三视图主角',
    type: 'character',
    confidence: 1,
    evidence: '用户指定 character-turnaround.png 作为三视图角色参考',
    aliases: ['主角', '角色', '该角色', '人物', 'the character', 'turnaround character'],
  },
  supportingCharacters: [],
  props: ['霓虹红绿灯光', '高脚杯', '海边酒吧灯饰', '游艇远灯'],
  environments: ['夜晚海边', '湿沙海岸', '灯红酒绿的海边夜生活场景'],
  relationships: [
    '主角来源于给定的三视图 character-turnaround.png',
    '主角置身于夜晚海边的灯红酒绿场景中',
    '霓虹、酒杯和海边夜生活元素围绕主角服务，不替代主角成为连续视觉中心',
  ],
  actions: ['出现在夜晚海边场景中', '在海边夜景中移动', '在霓虹灯光环境中展示', '拿起高脚杯', '沿湿沙和海岸步道行走'],
  protagonistAccessories: [],
  worldModel: {
    lighting: 'nighttime neon nightlife lighting with saturated red, green, gold, and dark ocean blue reflections',
    timeOfDay: 'night',
    gravity: 'normal earth gravity',
    wardrobe: {
      permanent: ['主角外观、服装轮廓、头发/头部轮廓、体态比例与身份设计保持与 character-turnaround.png 三视图一致'],
      variable: [],
    },
    clutter: ['海边酒吧', '霓虹灯牌', '湿沙反光', '游艇远灯', '玻璃和金属反射', '夜生活灯饰'],
    palette: ['night black', 'dark ocean blue', 'neon red', 'neon green', 'champagne gold', 'saturated nightlife colors'],
    mood: 'decadent glamorous neon-soaked seaside nightlife, 灯红酒绿, 纸醉金迷',
    soundscape: 'ocean surf, distant club bass, glass clinks, soft seaside wind',
    cameraVocabulary: ['35mm gimbal tracking', '50mm dolly-in', 'crane-down', 'parallax push', 'cinematic neon rim light'],
    identityLockedProps: ['character-turnaround.png as the global locked identity reference'],
    sceneVariableProps: ['高脚杯', '霓虹灯牌', '海边吧台', '灯串', '游艇灯光'],
    visualRhymes: ['recurring neon red and green reflections', 'wet sand perspective lines', 'dark ocean backdrop', 'champagne bokeh'],
    continuityRules: [
      '30 秒视频始终保持夜晚海边场景基调。',
      '主角身份必须遵循给定三视图 character-turnaround.png，不应在镜头间改变基础外观。',
      '灯红酒绿、纸醉金迷的视觉氛围贯穿全片，但不能抢走主角中心地位。',
      '每个镜头必须包含连续身体动作和环境运动。',
    ],
    exclusions: [
      '不要生成与三视图无关的新主角。',
      '不要让酒杯、霓虹灯或海景连续取代主角成为主体。',
      '不要出现手部隔空制造海水飞溅的物理错误。',
      '不要使用手写 SVG/canvas/程序化占位图替代真实视觉生成。',
    ],
    spatialReality: {
      groundSurface: '湿沙、海边步道或露天吧台地面；主角站立和行走时脚必须真实接触支撑表面',
      waterLine: '海水位于海岸线；只有浪花抵达脚边或脚踝时才接触主角，其他身体部位不应凭空影响海面',
      perspectiveCues: '暗色海面在背景，湿沙和步道在前景，海平面、地面与角色尺度保持清晰分离',
      physicsRules: [
        '正常地球重力，脚步、杯子、衣物和头发都遵守重力与风。',
        '酒杯必须稳定握持或放置，液体随动作晃动但不无因飞溅。',
        '霓虹反射必须贴合湿沙、玻璃、金属和海面几何。',
        '海水只在实际接触水线时产生涟漪或水花。',
      ],
      forbiddenSpatialErrors: [
        '脚不能悬浮在沙地或步道上方。',
        '手在胸口或空中挥动不能让远处海面或脚边水花飞溅。',
        '角色身体、服装、头发不能穿过吧台、酒杯、灯具、地面或海水表面。',
        '海平面不能无故升到腰部或胸部。',
      ],
    },
  },
  mode: 'character',
  modeRationale: '用户指定三视图角色作为长视频测试的核心连续性对象，海边灯红酒绿场景用于承载角色展示。',
  source: 'user-clarification',
};

const action = {
  type: 'generate_long_video',
  prompt: story,
  story,
  title: TITLE,
  projectId: PROJECT_ID,
  totalDuration: TOTAL_DURATION,
  ratio: '16:9',
  assemblyMode: 'saga',
  chainReferenceFrames: 'auto',
  colorMatch: true,
  generateAudio: true,
  quality: 'standard',
  fps: 30,
  defaultTransition: 'crossfade',
  crossfadeMs: 300,
  referenceImagePaths: [TURNAROUND_PATH],
  referenceNotes: ['character-turnaround.png 是全局角色身份三视图参考，必须贯穿全部镜头。'],
  shots,
  continuity: {
    characters: ['三视图主角：严格参考 character-turnaround.png，身份、轮廓、服装设计和体态比例全片一致'],
    wardrobe: ['保持三视图中的服装轮廓、材质暗部和身份设计，不跨镜头变装'],
    props: ['高脚杯', '霓虹灯牌', '海边吧台', '灯串', '游艇远灯'],
    locations: ['夜晚海边', '湿沙岸线', '海边露天酒吧和步道'],
    palette: ['neon red', 'neon green', 'dark ocean blue', 'champagne gold', 'night black'],
    lighting: '高饱和红绿霓虹、香槟色高光、暗海蓝黑背景、湿沙镜面反射',
    cameraLanguage: 'cinematic Saga long-video coverage, active gimbal/dolly/crane movement, Arri Alexa LogC, anamorphic bokeh',
    mood: '灯红酒绿、纸醉金迷、奢华但物理真实的夜晚海边氛围',
  },
  narrativeEntities,
};

const context = {
  cwd: repoRoot,
  permissionMode: 'full-access',
  isAdmin: true,
  sessionId: 'night-beach-long-video-test',
};

console.log(`Starting ${TOTAL_DURATION}s Saga long video test: ${TITLE}`);
console.log(`Workspace: ${repoRoot}`);
console.log(`Reference: ${TURNAROUND_PATH}`);

const result = await executeGenerateLongVideo(action, context);

console.log('\n--- generate_long_video result ---');
console.log(result.output);

if (!result.ok) {
  console.error('\nGeneration failed.');
  if (result.error) console.error(JSON.stringify(result.error, null, 2));
  process.exit(1);
}

console.log('\nGeneration completed.');
if (result.data) {
  console.log(JSON.stringify(result.data, null, 2));
}
