#!/usr/bin/env tsx
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';

async function main(): Promise<void> {
  const projectId = process.env.SAGA_HF_PROJECT_ID || `saga-hf-${Date.now()}`;

  // Fresh story to bust any prior BytePlus caches and to truly stress the
  // hold-frame transition recipe with two visually-different shot pairs.
  const story = [
    'In a quiet city park at sunrise, an old man named Lao Wei sits on a wooden bench feeding pigeons.',
    'He wears a navy blue cotton coat and a soft gray newsboy cap.',
    'A small wicker basket of breadcrumbs rests beside him on the bench.',
    'In the second moment, his small white terrier sits patiently at his feet, looking up.',
    'In the third moment, Lao Wei watches the pigeons take flight together as the sun climbs over distant rooftops.',
  ].join(' ');

  const action = {
    type: 'generate_long_video' as const,
    projectId,
    prompt: story,
    story,
    ratio: '9:16',
    totalDuration: 15,
    assemblyMode: 'saga' as const,
    chainReferenceFrames: 'auto' as const,
    // Mix transitions: cinematic-fade (hold-frame) → light-leak (hold-frame).
    // Both should now produce CLEAN crossfades between frozen frames.
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
        'Lao Wei — early 70s East Asian man, soft kind smile, weathered face with light wrinkles, gray-white short hair under a soft gray newsboy cap',
        'a small white short-haired terrier dog, calm, sitting upright',
      ],
      wardrobe: [
        'navy blue cotton button-up coat (#1A2A4F) over a beige collared shirt, brown trousers, brown leather shoes, soft gray wool newsboy cap (#A8AEB5)',
      ],
      props: [
        'small wicker basket of breadcrumbs resting on the bench',
        'wooden park bench with weathered slats, painted dark green',
      ],
      locations: [
        'quiet city park at sunrise; a wooden bench under tall ginkgo trees with golden morning light slanting from camera-left at low angle; soft mist near the ground',
      ],
      palette: ['#1A2A4F navy', '#D9B26A warm sunrise gold', '#7A8A4F muted ginkgo green', '#A8AEB5 soft gray'],
      lighting:
        'low golden sunrise sunlight from camera-left at 15 degrees above horizon; warm amber bounce from camera-right; soft ground mist diffusing the light; consistent 2800K warm color temperature',
      cameraLanguage:
        'cinematic 9:16 framing on a 50mm-feel lens; locked-off establishing on shot 1; low-angle close-up at the dog level on shot 2; gentle dolly back to a wide reveal on shot 3',
      mood: 'calm, gentle, contemplative; warm and unhurried; never melodramatic',
    },
    shots: [
      {
        title: 'Lao Wei feeding pigeons on the bench',
        duration: 5,
        storyBeat:
          '0–2s Lao Wei sits calmly on the wooden bench in soft sunrise light, holding a small piece of bread. 2–4s several pigeons gather and peck near his feet on the path. 4–5s he gently scatters more crumbs from the wicker basket. The whole 5s is the still scene of him feeding pigeons.',
        visualPrompt:
          'Cinematic 9:16 medium shot at chest height. Lao Wei, early 70s East Asian man, gray-white hair under a soft gray newsboy cap, soft kind smile, weathered face. He wears a navy blue cotton coat (#1A2A4F) over a beige collared shirt and sits on a weathered dark green wooden bench. Small wicker basket of breadcrumbs beside him. Several pigeons peck near his feet on the path. Low golden sunrise light from camera-left at 15 degrees, warm amber bounce, soft ground mist, ginkgo trees out of focus behind. 50mm lens feel, shallow depth of field, IMAX 70mm grain, anamorphic warmth in highlights.',
        camera:
          'Locked-off cinematic medium shot at chest height with subtle ambient camera breathing, no zoom, 50mm focal feel, shallow depth of field.',
        continuity:
          'Same Lao Wei, same navy blue cotton coat (#1A2A4F), same soft gray newsboy cap (#A8AEB5), same weathered green wooden bench, same low golden sunrise light from camera-left at 15 degrees.',
        transition: 'Settles into a calm steady frame of him scattering crumbs, light catching the falling crumbs.',
        transitionKind: 'cinematic-fade' as const,
        prompt: '',
      },
      {
        title: 'The white terrier looking up',
        duration: 5,
        storyBeat:
          '0–2s a small white short-haired terrier sits patiently at the foot of the same bench, looking up calmly. 2–4s its ears tilt slightly as a pigeon flies past in the background. 4–5s it remains seated, tail wagging gently once, looking up. The whole 5s is a tender low-angle close-up on the dog.',
        visualPrompt:
          'Cinematic 9:16 low-angle close-up at the dog level. A small white short-haired terrier sits upright on a soft mossy ground beside the same weathered dark green wooden bench. Same soft gray sunrise haze, same low golden light from camera-left at 15 degrees, same ginkgo trees out of focus behind. We can see Lao Wei\'s navy blue coat sleeve and brown trouser cuffs at the top of frame. 50mm lens feel, shallow depth of field, soft warm IMAX 70mm grain, anamorphic warmth.',
        camera:
          'Low-angle stable close-up at dog eye level with very subtle ambient camera breathing, 50mm focal feel.',
        continuity:
          'Same weathered dark green wooden bench, same Lao Wei (only sleeve and trouser cuffs visible at frame top — same navy blue cotton coat and brown trousers), same low golden sunrise light from camera-left, same small white terrier from the previous beat.',
        transition: 'Closes on a tender stable frame of the terrier looking up, ears slightly tilted.',
        transitionKind: 'light-leak' as const,
        prompt: '',
      },
      {
        title: 'Pigeons take flight at sunrise',
        duration: 5,
        storyBeat:
          '0–2s Lao Wei on the same bench gently watches the pigeons gathered at his feet. 2–4s the pigeons take flight together in a soft flutter of wings. 4–5s the camera dollies back slowly to reveal the wider park, the sun climbing higher over distant rooftops. The whole 5s is the gentle moment of pigeons rising.',
        visualPrompt:
          'Cinematic 9:16 wide shot, gentle dolly back. Lao Wei, same navy blue cotton coat (#1A2A4F), same soft gray newsboy cap, sits on the same weathered dark green wooden bench. Pigeons take flight together in soft wing flutters around him. Same small white terrier sits at his feet. Sun climbs higher over distant rooftops at the back of frame. Same low golden sunrise light from camera-left, soft ground mist, ginkgo trees framing the path. 50mm lens feel, shallow depth of field, IMAX 70mm grain, anamorphic warmth.',
        camera:
          'Gentle dolly-back from medium to wide, 50mm focal feel, smooth ground motion.',
        continuity:
          'Same Lao Wei, same navy blue cotton coat (#1A2A4F), same soft gray newsboy cap (#A8AEB5), same weathered green wooden bench, same small white terrier, same low golden sunrise light from camera-left.',
        transition: 'Ends on a calm stable wide frame as the last pigeon rises into the warm sky.',
        transitionKind: 'crossfade' as const,
        prompt: '',
      },
    ],
  };

  const result = await executeGenerateLongVideo(action, {
    cwd: process.cwd(),
    permissionMode: 'full-access',
    sessionId: 'saga-hf-smoke',
  });
  console.log(JSON.stringify({ ok: result.ok, output: result.output }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
