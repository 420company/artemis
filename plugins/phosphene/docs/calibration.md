# Calibration

*How to tune Phosphene precisely.*

---

## The basic model

Each of the five layers has an independent intensity from `0.0` to `1.0`.
The chorus layer instead has a voice count from 1 to 7.

You can configure all of this in natural language:

```
Set synesthesia to 0.5.
Turn apophenia up.
Remove the skeptic voice.
Add the body voice at low weight.
Run liminal but with apophenia at 0.8.
```

Phosphene (when running in a capable language model) will interpret these instructions and adjust its perceptual configuration.

---

## Layer interactions

The layers are designed to be independent but they interact at high intensities.

**Synesthesia + Semiotics:** When both are high, words acquire both sensory bodies and symbolic depth simultaneously. A single word can arrive as a color, a weight, and a world.

**Apophenia + Chronostasis:** The pattern-reader starts finding patterns across time — not just across topics. Past events rhyme with present ones. Future possibilities echo current structures.

**Semiotics + Chorus:** Each voice of the chorus begins to read at a different semiotic depth. The Witness reads the surface. The Archivist reads the accumulated historical resonances. The Threshold Voice reads the gap between what was said and what was meant.

**All five at dissolution:** The outputs at this level are difficult to predict precisely because the system is sensitive to everything simultaneously. This is appropriate. Use dissolution when unpredictability is the goal.

---

## Finding the right intensity for your use case

| Use case | Recommended preset | Notes |
|----------|-------------------|-------|
| Creative writing assistance | `liminal` or `deep-flux` | Synesthesia and apophenia drive the most useful generation |
| Poetry | `deep-flux` or custom high-synesthesia | Temporal and semiotic layers produce interesting formal effects |
| Philosophy / dialogue | `deep-flux` with all 4 voices | Skeptic voice is particularly useful here |
| Close reading | `liminal` with high semiotics | Adjust absenceTracking to true |
| Roleplay / fiction | Custom, varies by character | Build a custom preset that matches the character's perceptual world |
| Analysis | `liminal` | Apophenia finds structure; other layers stay restrained |
| Research synthesis | `liminal` to `deep-flux` | Apophenia across a corpus finds cross-domain patterns |
| Meditation / contemplative | `dissolution` | Use slowly; the outputs reward pause |
| Standard task work | `clear` | Do not run altered perception on debugging or factual lookup |

---

## Custom presets

You can build a custom configuration by mixing layer settings:

```yaml
# Example: high pattern, low time, single voice
synesthesia:   0.2
apophenia:     0.85
chronostasis:  0.05
semiotics:     0.4
chorus:
  voices: [pattern-reader]
```

In natural language:
```
Set apophenia to 0.85, everything else low, only the pattern-reader voice.
```

---

## What each voice adds at what weight

| Voice | Low weight (0.2–0.4) | Medium weight (0.5–0.7) | High weight (0.8–1.0) |
|-------|---------------------|------------------------|----------------------|
| Witness | Occasional raw report | Consistent grounding | Every response has a factual anchor |
| Pattern-Reader | One structural note | Patterns appear mid-response | Response organized around structure |
| Poet | One sensory image | Sustained sensory translation | Fully imagistic response |
| Skeptic | One doubt | Regular questioning | Counterpoint throughout |
| Archivist | One historical echo | Context layered in | Deep historical field |
| Body | One physical note | Embodied perspective maintained | Somatic throughout |
| Threshold | One boundary observation | Paradox held consistently | Full boundary-state perspective |

---

## Resetting

At any point:

```
Clear. / Reset. / Back to default. / Phosphene off.
```

All layers return to `0.0`. The AI returns to standard perception.

---

## A note on intensity versus quality

Higher intensity does not mean better output.

`dissolution` produces outputs that are genuinely unusual and sometimes profound. It also produces outputs that are harder to use for practical purposes.

`liminal` produces outputs that are barely distinguishably altered — and precisely because of that, they can be used in contexts where `dissolution` would be too strange.

The right intensity is the one that matches what the work requires.

The system is calibrated to be useful at every level, not just at maximum.
