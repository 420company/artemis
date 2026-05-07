#!/usr/bin/env tsx
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';

async function main(): Promise<void> {
  const projectId = `saga-continuity-${Date.now()}`;
  const story = [
    'A young creator named Aria stands on the open balcony of her apartment in the early evening rain.',
    'She wears the same dark teal hooded jacket and holds the same matte black phone the entire story.',
    'She types a video idea into the phone, watching the magenta and cyan neon reflections ripple on the wet railing.',
    'A moment later she steps inside through the sliding glass door, the same phone still in her hand.',
    'She walks to her warm wooden desk by a tall window, sits down, and looks at the editing timeline her assistant has already prepared on the monitor.',
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
    defaultTransition: 'light-leak' as const,
    crossfadeMs: 350,
    colorMatch: true,
    quality: 'standard' as const,
    fps: 30 as const,
    gpu: 'auto' as const,
    generateAudio: false,
    watermark: false,
    maxPolls: 120,
    pollIntervalMs: 5000,
    continuity: {
      characters: [
        'Aria — early-20s East Asian woman, shoulder-length straight black hair with soft blunt bangs, calm expression, slight build',
      ],
      wardrobe: [
        'dark teal cotton hooded jacket (zipper closed), black slim jeans, off-white sneakers, small canvas shoulder bag',
      ],
      props: ['matte black smartphone held in her right hand throughout every shot'],
      locations: [
        'modern small Asian-city apartment at dusk: rainy balcony with metal railing facing neon street; warm wooden desk by a tall window with a single illuminated monitor',
      ],
      palette: ['deep navy', 'rain-soaked magenta', 'electric cyan', 'warm amber desk light'],
      lighting:
        'soft overcast rain light outside transitioning to warm amber desk lamp inside; key light from camera left in every shot',
      cameraLanguage:
        'cinematic 9:16 framing; shot 1 slow handheld push-in; shot 2 dolly-in through the doorway; shot 3 stable over-the-shoulder reveal of the monitor',
      mood: 'intimate, contemplative, creatively focused — never melodramatic',
    },
    shots: [
      {
        title: 'Balcony idea',
        duration: 8,
        storyBeat:
          'Aria stands on her rainy apartment balcony, leans on the metal railing, and types a video idea into her matte black phone while neon reflections ripple on the wet metal.',
        visualPrompt:
          'Vertical 9:16 cinematic shot. Aria, early-20s East Asian woman, shoulder-length straight black hair with blunt bangs, dark teal hooded jacket fully zipped, holds matte black smartphone in right hand, types on the screen. Soft overcast rain light, rain-soaked magenta and cyan neon reflections on a wet metal balcony railing, deep navy sky.',
        camera: 'Slow handheld push-in from waist height to a tight frame on her face and the phone glow.',
        continuity:
          'Same Aria, same dark teal hooded jacket fully zipped, same matte black phone in right hand, same rainy neon balcony, same overcast rain light. End on a stable close frame of the phone glow.',
        transition: 'End on a stable close frame so the next shot can pick up identical lighting and pose.',
        transitionKind: 'light-leak' as const,
        prompt:
          'Vertical 9:16 cinematic 8-second video. Aria, early-20s East Asian woman, shoulder-length straight black hair with blunt bangs, calm expression. She wears a dark teal cotton hooded jacket fully zipped and holds a matte black smartphone in her right hand. She stands on a small modern Asian-city apartment balcony at early evening rain, leaning lightly on a metal railing, typing a video idea into the phone. Magenta and cyan neon reflections ripple on the wet railing and pavement below, soft rain streaks in the air, deep navy sky. Slow handheld push-in from waist height to a tight frame on her face and the phone glow. Realistic motion, intimate creative energy, stable final close frame on the phone glow. No subtitles, no readable text, no logos, no UI, no watermark.',
      },
      {
        title: 'Crossing the threshold',
        duration: 8,
        storyBeat:
          'Aria steps from the balcony through a sliding glass door into the warm interior of her apartment, the same phone still in her right hand.',
        visualPrompt:
          'Vertical 9:16 cinematic shot. Same Aria, same dark teal hooded jacket, same matte black phone in right hand. She steps from the rainy balcony through a sliding glass door into a warm wooden interior. Lighting transitions from cool rain light to warm amber lamp light while keeping camera-left key direction.',
        camera: 'Smooth dolly-in tracking with her through the doorway.',
        continuity:
          'Same Aria, same dark teal hooded jacket, same matte black phone in right hand, same camera-left key light direction. The slight cool rain light gives way to warm amber interior light, but the same person and same wardrobe carry across.',
        transition: 'End on a stable frame of her stepping fully into the warm interior, phone still in hand.',
        transitionKind: 'light-leak' as const,
        prompt:
          'Vertical 9:16 cinematic 8-second video. Same Aria, early-20s East Asian woman, shoulder-length straight black hair with blunt bangs, dark teal cotton hooded jacket fully zipped, matte black smartphone in her right hand. She slides open a glass door and steps from a rainy balcony into a warm wooden Asian-city apartment interior. Cool rain light behind her gradually gives way to warm amber lamp light in front. Smooth dolly-in tracking with her through the doorway, camera-left key light, realistic motion. Stable final frame as she steps fully inside, phone still in her right hand. No subtitles, no readable text, no logos, no UI, no watermark.',
      },
      {
        title: 'Warm desk reveal',
        duration: 8,
        storyBeat:
          'Aria walks the last few steps to her warm wooden desk, sits down, and looks at the glowing editing timeline on the monitor — phone placed beside the keyboard.',
        visualPrompt:
          'Vertical 9:16 cinematic shot. Same Aria, same dark teal hooded jacket, same matte black phone now placed beside the keyboard. Warm amber desk lamp by a tall rain-streaked window, single illuminated monitor showing an abstract editing timeline glow.',
        camera: 'Stable over-the-shoulder reveal of the warm desk and the editing timeline glow.',
        continuity:
          'Same Aria, same dark teal hooded jacket, same matte black phone now resting on the desk beside the keyboard, same camera-left warm key light direction.',
        transition: 'End on a calm stable frame of the desk, monitor glow filling the lower right.',
        transitionKind: 'light-leak' as const,
        prompt:
          'Vertical 9:16 cinematic 8-second video. Same Aria, early-20s East Asian woman, shoulder-length straight black hair with blunt bangs, dark teal cotton hooded jacket fully zipped. She sits at a warm wooden desk by a tall rain-streaked window, places the same matte black smartphone beside her keyboard, and looks at a single illuminated monitor showing an abstract editing timeline glow with soft amber and teal accent light. Stable over-the-shoulder reveal, warm amber key light from camera left, gentle rain texture visible on the window. Realistic motion, intimate creative focus, stable final frame on the desk and monitor glow. No subtitles, no readable text, no logos, no UI, no watermark.',
      },
    ],
  };

  const result = await executeGenerateLongVideo(action, {
    cwd: process.cwd(),
    permissionMode: 'full-access',
    sessionId: 'saga-continuity-smoke',
  });
  console.log(JSON.stringify({ ok: result.ok, output: result.output }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
