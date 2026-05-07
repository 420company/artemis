#!/usr/bin/env tsx
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';

async function main(): Promise<void> {
  // Pin a stable projectId so re-runs can reuse already-generated segments.
  const projectId = process.env.SAGA_V2_PROJECT_ID || `saga-v2-${Date.now()}`;

  // Calmer, low-safety-risk story to keep the BytePlus audio safety filter
  // happy. Three intimate beats in a single kitchen — strong identity
  // continuity by design.
  const story = [
    'In a warm sunlit kitchen, a young woman named Mei sits at a wooden table.',
    'She wears the same cream-colored knit sweater throughout the entire story.',
    'A ceramic mug of coffee with gentle steam sits in front of her, and a small leather notebook lies open on the table.',
    'She holds a black ballpoint pen and sketches small rough shapes onto the notebook page, focused and calm.',
    'She pauses, smiles softly at her sketch, takes a small sip from the same ceramic mug, and leans gently back into the wooden chair.',
  ].join(' ');

  const action = {
    type: 'generate_long_video' as const,
    projectId,
    prompt: story,
    story,
    ratio: '9:16',
    totalDuration: 24,
    assemblyMode: 'saga' as const,
    chainReferenceFrames: 'auto' as const,
    defaultTransition: 'crossfade' as const,
    crossfadeMs: 400,
    colorMatch: true,
    quality: 'standard' as const,
    fps: 30 as const,
    gpu: 'auto' as const,
    generateAudio: true,
    watermark: false,
    maxPolls: 120,
    pollIntervalMs: 5000,
    continuity: {
      characters: [
        'Mei — early-20s East Asian woman, shoulder-length straight black hair tucked behind both ears, calm soft smile, slim build',
      ],
      wardrobe: [
        'cream-colored chunky knit pullover sweater (long sleeves), no jewelry, no makeup',
      ],
      props: [
        'matte cream ceramic coffee mug with gentle visible steam',
        'small open leather notebook with cream pages',
        'matte black ballpoint pen held in her right hand from shot 2 onwards',
      ],
      locations: [
        'warm wooden kitchen table; soft morning sunlight from a window on camera-left; out-of-focus light wood cabinets and a small potted plant in the background',
      ],
      palette: ['warm cream', 'soft amber sunlight', 'wood brown', 'gentle ivory'],
      lighting: 'soft golden morning sunlight from camera-left; warm bounce fill on the right; same color temperature in every shot',
      cameraLanguage: 'cinematic 9:16 framing; locked-off establishing on shot 1; gentle handheld push-in on shot 2; stable medium close-up on shot 3',
      mood: 'intimate, contemplative, creatively focused; never melodramatic',
    },
    shots: [
      {
        title: 'Sitting with coffee and notebook',
        duration: 8,
        storyBeat:
          'Mei sits calmly at her wooden kitchen table in soft golden morning sunlight, looking down at her open leather notebook with a steaming cream mug beside it. Her cream knit sweater covers her arms; her hands rest gently on the table. The whole 8 seconds is the still scene of her seated at the table — not a close-up of any single object.',
        visualPrompt:
          'Vertical 9:16 cinematic medium shot. Mei, early-20s East Asian woman, shoulder-length straight black hair tucked behind both ears, soft calm smile, wearing a cream chunky knit sweater. She sits at a warm wooden kitchen table in soft golden morning sunlight from camera-left. A matte cream ceramic mug with gentle visible steam sits in front of her, and a small open leather notebook with cream pages lies on the table. Out-of-focus light wood cabinets and a small green potted plant in the background.',
        camera: 'Locked-off cinematic medium shot at chest height, very subtle ambient breathing motion only.',
        continuity:
          'Same Mei, same cream knit sweater, same matte cream ceramic mug with steam, same small leather notebook open on the wooden table. Same warm golden morning sunlight from camera-left in every shot.',
        transition: 'Settles into a calm steady frame of her seated at the table.',
        transitionKind: 'crossfade' as const,
        prompt: '',
      },
      {
        title: 'Picking up the pen and sketching',
        duration: 8,
        storyBeat:
          'Mei reaches for a matte black ballpoint pen on the table, picks it up with her right hand, and begins sketching small rough shapes onto the open notebook page. Her cream knit sweater, the steaming ceramic mug, the wooden table, the camera-left morning sunlight — everything else stays exactly the same as the previous shot.',
        visualPrompt:
          'Vertical 9:16 cinematic medium shot, gentle handheld push-in. Same Mei, same cream chunky knit sweater, same shoulder-length black hair, same calm focused expression. She picks up a matte black ballpoint pen with her right hand and starts sketching small rough shapes on the open leather notebook page. Same warm golden morning sunlight from camera-left, same out-of-focus wooden kitchen background, same matte cream ceramic mug with gentle steam beside the notebook.',
        camera: 'Gentle handheld cinematic push-in toward the pen and notebook page, natural breathing motion.',
        continuity:
          'Same Mei, same exact cream knit sweater, same hair, same warm golden sunlight from camera-left, same wooden table, same matte cream ceramic mug with gentle steam, same open leather notebook with cream pages.',
        transition: 'Holds steady on her hand sketching on the notebook page.',
        transitionKind: 'match-cut' as const,
        prompt: '',
      },
      {
        title: 'Soft smile and sip',
        duration: 8,
        storyBeat:
          'Mei pauses sketching, looks down softly at her finished rough shapes on the notebook page, smiles gently to herself, lifts the same matte cream ceramic mug, takes a small calm sip of coffee, lowers the mug, and leans gently back into the wooden chair. Same kitchen, same sweater, same lighting throughout the full 8 seconds.',
        visualPrompt:
          'Vertical 9:16 cinematic medium close-up. Same Mei, same cream chunky knit sweater, same shoulder-length black hair, same warm focused expression now softening into a gentle smile. She lifts the same matte cream ceramic mug to her lips, takes a small calm sip, lowers the mug, and leans gently back into the wooden chair. Warm golden morning sunlight from camera-left, same out-of-focus wooden kitchen background.',
        camera: 'Stable medium close-up at face height; very subtle ambient handheld breathing motion only.',
        continuity:
          'Same Mei, same cream knit sweater, same hair, same matte cream ceramic mug, same warm golden morning sunlight from camera-left, same wooden kitchen.',
        transition: 'Ends on a stable calm frame of her leaning back with the mug in her hand.',
        transitionKind: 'speed-ramp' as const,
        prompt: '',
      },
    ],
  };

  const result = await executeGenerateLongVideo(action, {
    cwd: process.cwd(),
    permissionMode: 'full-access',
    sessionId: 'saga-v2-smoke',
  });
  console.log(JSON.stringify({ ok: result.ok, output: result.output }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
