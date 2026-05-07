#!/usr/bin/env tsx
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';

async function main(): Promise<void> {
  const projectId = process.env.SAGA_V3_PROJECT_ID || `saga-v3-${Date.now()}`;

  // 2 shots × 6s = 12s. Shorter run to validate the v3 pipeline end-to-end
  // without burning a full 24s of API time. Same kitchen-sketch theme so
  // we can compare against v2.
  const story = [
    'In a warm sunlit kitchen, a young woman named Mei sits at a wooden table.',
    'She wears a cream-colored knit pullover sweater the entire time.',
    'A ceramic mug of coffee with gentle steam sits in front of her, and a small leather notebook lies open on the table.',
    'She softly turns a page of the notebook with her right hand and lets the morning sunlight fall across the page.',
  ].join(' ');

  const action = {
    type: 'generate_long_video' as const,
    projectId,
    prompt: story,
    story,
    ratio: '9:16',
    totalDuration: 12,
    assemblyMode: 'saga' as const,
    chainReferenceFrames: 'auto' as const,
    defaultTransition: 'cinematic-fade' as const,
    crossfadeMs: 500,
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
        'Mei — early-20s East Asian woman, shoulder-length straight black hair tucked behind both ears, soft contemplative expression, slim build',
      ],
      wardrobe: [
        'cream-colored chunky knit pullover sweater (#F4ECDC), long sleeves rolled to mid-forearm, no jewelry, no makeup',
      ],
      props: [
        'matte cream ceramic coffee mug (#EFE5D2) with gentle visible steam',
        'small open leather notebook with cream pages and visible faint pencil sketches',
      ],
      locations: [
        'warm wooden kitchen table; soft golden morning sunlight from a window on camera-left; out-of-focus light wood cabinets in the background',
      ],
      palette: ['#F4ECDC cream', '#D4A574 amber sunlight', '#8B6F47 wood brown', '#FFFFFF gentle ivory'],
      lighting: 'soft golden morning sunlight from camera-left at roughly 35 degrees; warm amber bounce fill on right; consistent 3200K color temperature in every shot',
      cameraLanguage: 'cinematic 9:16 framing on a 50mm-feel lens; locked-off establishing on shot 1; gentle handheld push-in on shot 2; shallow depth of field; subtle anamorphic-flavored bokeh in highlights',
      mood: 'intimate, contemplative, creatively focused; warm and gentle; never melodramatic',
    },
    shots: [
      {
        title: 'Sitting calmly at the kitchen table',
        duration: 6,
        storyBeat:
          '0–2s Mei sits at the wooden kitchen table in the soft golden morning light, her hands resting on the table on either side of the open notebook. 2–4s the steam from the matte cream ceramic mug drifts upward in slow curling spirals. 4–6s she breathes softly and settles deeper into the wooden chair while the light shifts incrementally warmer. The whole scene is the still moment of her seated at the table.',
        visualPrompt:
          'Cinematic 9:16 medium shot at chest height. Mei, early-20s East Asian woman with shoulder-length straight black hair, soft contemplative expression, sits at a warm wooden kitchen table wearing a cream chunky knit pullover sweater. A matte cream ceramic mug (#EFE5D2) with curling steam sits in front of her. Soft golden 3200K morning sunlight from camera-left at 35 degrees, IMAX 70mm-grain texture, 50mm-feel lens with shallow depth of field, subtle warm anamorphic bokeh in the out-of-focus light wood cabinets behind her.',
        camera:
          'Locked-off cinematic medium shot at chest height with very subtle ambient camera breathing, no zoom, 50mm normal focal feel.',
        continuity:
          'Same Mei, same cream chunky knit pullover sweater (#F4ECDC), same matte cream ceramic mug (#EFE5D2) with curling steam, same warm wooden table, same golden 3200K morning sunlight from camera-left at 35 degrees.',
        transition: 'Settles into a calm steady frame with the steam from the mug catching golden light.',
        transitionKind: 'cinematic-fade' as const,
        prompt: '',
      },
      {
        title: 'Turning a page softly',
        duration: 6,
        storyBeat:
          '0–2s Mei lowers her gaze to the open notebook on the table. 2–4s her right hand drifts down and softly turns a page; the cream paper catches the warm morning light as it bends. 4–6s the new page settles flat and her hand rests beside it; warm light falls across the fresh page. The whole 6 seconds is the gentle motion of turning the page; same Mei, same sweater, same mug, same kitchen, same lighting key from camera-left.',
        visualPrompt:
          'Cinematic 9:16 medium shot, gentle handheld push-in toward the open leather notebook. Same Mei in the cream chunky knit pullover sweater, same shoulder-length straight black hair, same soft contemplative expression. Her right hand drifts down and turns a cream notebook page; the paper bends softly and catches the golden 3200K morning light from camera-left. Same matte cream ceramic mug (#EFE5D2) with steam beside the notebook on the warm wooden table. 50mm-feel lens, shallow depth of field, IMAX 70mm grain, anamorphic warmth in the out-of-focus light wood background.',
        camera:
          'Gentle handheld cinematic push-in toward the notebook page, natural breathing motion, 50mm focal feel.',
        continuity:
          'Same Mei, same cream chunky knit pullover sweater (#F4ECDC), same hair, same warm wooden table, same matte cream ceramic mug (#EFE5D2) with curling steam, same golden 3200K morning sunlight from camera-left.',
        transition: 'Closes on a gentle stable frame of her hand resting beside the freshly turned page.',
        transitionKind: 'crossfade' as const,
        prompt: '',
      },
    ],
  };

  const result = await executeGenerateLongVideo(action, {
    cwd: process.cwd(),
    permissionMode: 'full-access',
    sessionId: 'saga-v3-smoke',
  });
  console.log(JSON.stringify({ ok: result.ok, output: result.output }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
