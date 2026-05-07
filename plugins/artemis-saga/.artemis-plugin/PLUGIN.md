# artemis-saga

Saga is Artemis's long-video production workflow.

Use it when the user asks to make a long video, complete video, multi-minute
video, full story video, edited video chain, or mobile-driven video production
workflow.

Behavior:

- Detect the configured video provider and model before planning.
- Respect provider segment limits instead of sending a full story to one short
  video API request.
- Ask for total target duration when the user did not specify one.
- Convert the story into a continuity bible, structured shot list, and
  provider-safe short segments.
- Before calling `generate_long_video`, produce an AI shot plan whenever the
  model has enough context. Each shot should include `title`, `duration`,
  `storyBeat`, `visualPrompt`, `camera`, `continuity`, `transition`, and a
  polished English video-generation `prompt`.
- Use `generate_long_video` as the primary tool.
- Prefer `assemblyMode: "auto"` so local Hyperframes can render when installed,
  while FFmpeg remains the dependable fallback.
- Treat Hyperframes as the first-class finishing layer: composition HTML,
  `design.md`, media tracks, audio tracks, transition overlays, an
  Artemis-owned finishing runtime, lint, inspect, and render all belong to the
  Saga project directory.
- Use the Hyperframes skills for advanced edits after the first cut:
  captions, TTS voiceover, transcript timing, audio-reactive visuals, GSAP,
  Three.js, Tailwind, Lottie, website-to-video, and registry-driven templates.
- For Bragi mobile requests, send the final MP4 back with `bridge_send_video`
  after `generate_long_video` succeeds.

Output expectations:

- A final MP4.
- A `saga-plan.json` with the analyzed shot list and final prompts.
- A `saga-manifest.json` with segment prompts and generated clip paths.
- A standard Hyperframes project under `hyperframes/` with `index.html`,
  `design.md`, copied media, `artemis-saga-runtime.js`,
  `artemis-saga.json`, and transition overlay timing.

Do not use Saga for single short clips. Ordinary short video requests should
continue through the existing Seedance / Vidar video workflow.
