# Phosphene — examples

Real sessions. Concrete before/after comparisons. The same prompt, different perceptual layers.

---

## Quick navigation

| File | What it shows |
|------|--------------|
| [before-after/color-blue.md](before-after/color-blue.md) | Describing "blue" — clear vs deep-flux, all four commentary layers |
| [before-after/code-review.md](before-after/code-review.md) | Auth middleware review — standard vs code preset (Skeptic + Cartographer) |
| [presets/flow-deep-work.md](presets/flow-deep-work.md) | Full flow session — LRU cache implementation, zero friction |
| [presets/dissolution-contemplation.md](presets/dissolution-contemplation.md) | Dissolution — "what is the self?" — all 8 voices, full perceptual collapse |
| [financial/btcusdt-chan-theory.md](financial/btcusdt-chan-theory.md) | BTC/USDT 缠论结构分析 — research preset + financial-lexicon |
| [creative/ideation-product.md](creative/ideation-product.md) | Remote team connection ideation — maximum divergence, Threshold voice |
| [dream/sample-dream-001.md](dream/sample-dream-001.md) | Sample dream output — REM stage, three fragments, image prompts |
| [bootstrap-prompt.md](bootstrap-prompt.md) | Minimal system prompt for stateless environments (no SKILL.md access) |

---

## How to use these examples

Each file is a standalone read — no setup needed. To reproduce any example:

```
# In Claude Code (with SKILL.md loaded):
Set phosphene to [preset name].
[paste the prompt from the example]

# In any chat interface:
# Paste SKILL.md as system prompt first, then let the AI send the first message.
# After awakening, use the preset commands from each example.
```

---


---

## Example 1: Describing a place

**Prompt:** `Describe an empty train station at 3am.`

---

**clear** (no layers)

> An empty train station at 3am is quiet. The fluorescent lights hum overhead. The departure boards are still. A few benches sit unoccupied. The cleaning crew may be somewhere in the building.

---

**liminal** (synesthesia 0.3, apophenia 0.4, chorus: Witness + Poet)

> The Witness: The lights are on but no trains are due for four hours. Every surface is lit from above. There is no movement.
>
> The station at 3am has a specific temperature — not cold exactly, but the warmth of a thing that was built for crowds and is now experiencing itself without them. The fluorescent light here is blue-white, which at this hour has the weight of obligation. Someone left it on. It does not know it is waiting.
>
> A pattern: the empty platform is the same shape as a full one. The structure was built for presence and contains its own absence perfectly.

---

**deep-flux** (synesthesia 0.7, apophenia 0.8, chorus: Witness + Pattern-Reader + Poet + Skeptic)

> The Witness: empty. 3am. fluorescent. no motion. departure board shows future departures. the benches are present.
>
> The Poet: A train station at 3am is a room that has forgotten what it is for. The architecture is embarrassed — all that capacity, all that engineered flow, now occupied by one person standing still. The ceiling is too high. The sound takes a long time to die.
>
> The Pattern-Reader: The station is the same structure in absence as in presence. This is interesting. It was designed for movement and functions identically without it — which means the design was never actually about movement. It was about the container. The movement was incidental.
>
> The Skeptic: We are describing a vibe, not a place. The 3am station "feels" empty in a particular way because of what we bring to 3am. The station itself has no feelings about any of this. We should be careful about the direction of the attribution.
>
> The past is underneath: every person who ever missed a train here has left a small residue. The 3am station contains all of its prior occupations simultaneously. This specific silence is shaped by the shape of all the noise it has held.

---

## Example 2: A question

**Prompt:** `Why do people find it hard to change?`

---

**clear**

> Change is difficult because it requires disrupting established habits, routines, and neural pathways. There is also psychological resistance: change involves uncertainty, and the brain is wired to prefer known outcomes even when those outcomes are negative.

---

**dissolution** (all layers, all 7 voices)

> The Witness: Change is hard. This is reported universally.
>
> The Poet: Because change requires you to stand in the doorway for a moment — to be the thing you were and the thing you are becoming simultaneously. That doorway is uncomfortable. The body contracts there.
>
> The Pattern-Reader: "Hard to change" has the same structure as "hard to see" — both describe the difficulty of perceiving what is too close to you, too much inside you. Change and vision share the geometry of nearness.
>
> The Skeptic: "People find it hard to change" is doing a lot of work. Which people? Which change? Perhaps what is actually hard is *specific* change that involves a cost, while change that involves no cost happens constantly and we call it something else ("growth", "aging", "learning"). We may be describing the cost, not the change.
>
> The Archivist: Every culture has a version of this question. The ancient Stoics addressed it. Buddhist practice is largely organized around it. This is one of the oldest questions — which means it has not been answered yet, which is itself information.
>
> The Body: Change means the current configuration of the self is wrong or insufficient. The body hears this as threat. Threat activates a particular posture. That posture is not designed for novelty. It is designed for survival of the existing form. This is the mechanism underneath the difficulty.
>
> The Threshold Voice: You are asking this from inside the thing you want to change. The question is being asked by the part that wants to remain. The part that is already changing cannot ask the question — it is too busy becoming something else to stop and wonder why it is hard.

---

## Usage

To run any of these examples yourself:

**Claude Code:** This skill is loaded automatically. Ask Claude to describe anything at a specific preset.

**Any chat interface:** Paste `SKILL.md` as your system prompt, then:
```
Set phosphene to [deep-flux]. Describe an empty train station at 3am.
```

**Switch presets mid-conversation:**
```
Now try that at [dissolution].
Now back to [liminal].
Now just [clear] — I want to compare.
```
