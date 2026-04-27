# Session Handoff

Date: 2026-04-26

## Current Goal

Fix the `/team` design workflow so visual assets and design prompts are generated from the current user task instead of fixed templates, and prevent low-quality fallback outputs from being presented as final work.

## Key Fixes Applied

- Fixed BytePlus media base URL normalization in `src/tools/byteplusMedia.ts`.
  - Bad config such as `/api/v3/images/generations` now normalizes to `/api/v3`.
  - Prevents duplicated endpoints like `/api/v3/images/generations/images/generations`.

- Updated BytePlus visual config in:
  - `.artemis/providers.json`
  - `/Users/goat/.artemis/providers.json`
  - Image and video base URLs now use `https://ark.ap-southeast.bytepluses.com/api/v3`.

- Added dynamic task signal extraction in `src/core/design.ts`.
  - Extracts current task keywords, domain/object terms, deliverables, style, materials, colors, and constraints from the user's prompt.
  - Feeds this signal into art direction, layout, polish, implementation, and visual asset planning.

- Updated visual asset prompt generation.
  - Content is now derived from the current user task.
  - Fixed guardrails remain only for quality/safety: no website screenshots, no UI mockups, no text overlays, no watermarks, no minors, no explicit sexual content.

- Added a hard asset gate.
  - If the user explicitly asks for product/photography/raster visual assets and none are generated, the design workflow stops instead of continuing with SVG placeholders or fake completion.

## Important Files

- `src/tools/byteplusMedia.ts`
- `src/core/design.ts`
- `.artemis/providers.json`
- `/Users/goat/.artemis/providers.json`

## Verification

Passed:

- `./node_modules/.bin/tsc --noEmit`
- `npm run build`
- `npm test`

Additional normalization check passed:

- `https://ark.ap-southeast.bytepluses.com/api/v3/images/generations/images/generations`
- normalizes to:
- `https://ark.ap-southeast.bytepluses.com/api/v3`

## Next Suggested Check

After logging back in, rerun a `/team` design task and confirm:

- BytePlus no longer returns duplicated endpoint 404 errors.
- Visual asset logs show real raster image files generated.
- Generated images are standalone product/domain assets, not website screenshots.
- If image generation fails, workflow stops at asset gate with a clear error instead of producing a poor fallback site.

