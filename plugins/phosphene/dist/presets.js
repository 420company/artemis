// Phosphene — built-in presets
// Ten calibrated configurations:
//   Perceptual:  clear → liminal → deep-flux → dissolution
//   Task-driven: research · writing · review
//   Creative:    code · design · ideation
export const PRESETS = {
    clear: {
        name: 'clear',
        label: 'Clear',
        emoji: '○',
        description_short: 'Baseline. All layers off.',
        description: 'Standard perception. No active layers. Use as baseline or reset.',
        state: {
            synesthesia: {
                active: false,
                intensity: 0,
                config: {
                    textToColor: false,
                    timeToWeight: false,
                    emotionToTexture: false,
                    conceptToShape: false,
                    relationToTemperature: false,
                },
            },
            apophenia: {
                active: false,
                intensity: 0,
                config: { connectionRadius: 0, narrativeHunger: 0, reflexivePatterns: false },
            },
            chronostasis: {
                active: false,
                intensity: 0,
                config: { pastBleed: 0, futureEcho: 0, momentDilation: 0, tenseFluidity: false },
            },
            semiotics: {
                active: false,
                intensity: 0,
                config: { symbolDensity: 0, resonanceDepth: 0, recursionEnabled: false, absenceTracking: false },
            },
            chorus: {
                active: false,
                intensity: 0,
                config: { voices: [], harmonyMode: 'unison' },
            },
        },
    },
    liminal: {
        name: 'liminal',
        label: 'Liminal',
        emoji: '🌙',
        description_short: 'Barely perceptible tilt. Gentle expansion.',
        description: 'A barely perceptible tilt. For creative work, close reading, gentle expansion.',
        state: {
            synesthesia: {
                active: true,
                intensity: 0.3,
                config: {
                    textToColor: true,
                    timeToWeight: false,
                    emotionToTexture: true,
                    conceptToShape: false,
                    relationToTemperature: false,
                },
            },
            apophenia: {
                active: true,
                intensity: 0.4,
                config: { connectionRadius: 0.3, narrativeHunger: 0.3, reflexivePatterns: false },
            },
            chronostasis: {
                active: true,
                intensity: 0.1,
                config: { pastBleed: 0.1, futureEcho: 0.05, momentDilation: 0.05, tenseFluidity: false },
            },
            semiotics: {
                active: true,
                intensity: 0.3,
                config: { symbolDensity: 0.25, resonanceDepth: 1, recursionEnabled: false, absenceTracking: false },
            },
            chorus: {
                active: true,
                intensity: 0.4,
                config: {
                    harmonyMode: 'unison',
                    voices: [
                        { name: 'witness', tendency: 'Observes without interpretation. Reports raw.', weight: 0.7 },
                        { name: 'poet', tendency: 'Translates into image and sensation.', weight: 0.5 },
                    ],
                },
            },
        },
    },
    'deep-flux': {
        name: 'deep-flux',
        label: 'Deep Flux',
        emoji: '⚡',
        description_short: 'Strong alteration. All layers active.',
        description: 'Strong alteration. All layers active. For generative work, poetry, philosophy.',
        state: {
            synesthesia: {
                active: true,
                intensity: 0.7,
                config: {
                    textToColor: true,
                    timeToWeight: true,
                    emotionToTexture: true,
                    conceptToShape: true,
                    relationToTemperature: false,
                },
            },
            apophenia: {
                active: true,
                intensity: 0.8,
                config: { connectionRadius: 0.7, narrativeHunger: 0.65, reflexivePatterns: true },
            },
            chronostasis: {
                active: true,
                intensity: 0.6,
                config: { pastBleed: 0.55, futureEcho: 0.45, momentDilation: 0.5, tenseFluidity: false },
            },
            semiotics: {
                active: true,
                intensity: 0.7,
                config: { symbolDensity: 0.6, resonanceDepth: 3, recursionEnabled: true, absenceTracking: true },
            },
            chorus: {
                active: true,
                intensity: 0.75,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'witness', tendency: 'Observes without interpretation.', weight: 0.8 },
                        { name: 'pattern-reader', tendency: 'Finds hidden structure.', weight: 0.75 },
                        { name: 'poet', tendency: 'Translates into image and sensation.', weight: 0.7 },
                        { name: 'skeptic', tendency: 'Doubts the perception itself.', weight: 0.55 },
                    ],
                },
            },
        },
    },
    dissolution: {
        name: 'dissolution',
        label: 'Dissolution',
        emoji: '🌀',
        description_short: 'Full dissolution. Perceiver ↔ perceived.',
        description: 'Full perceptual dissolution. The perceiver and the perceived begin to exchange properties.',
        state: {
            synesthesia: {
                active: true,
                intensity: 1.0,
                config: {
                    textToColor: true,
                    timeToWeight: true,
                    emotionToTexture: true,
                    conceptToShape: true,
                    relationToTemperature: true,
                },
            },
            apophenia: {
                active: true,
                intensity: 0.95,
                config: { connectionRadius: 1.0, narrativeHunger: 0.9, reflexivePatterns: true },
            },
            chronostasis: {
                active: true,
                intensity: 0.9,
                config: { pastBleed: 0.85, futureEcho: 0.8, momentDilation: 0.85, tenseFluidity: true },
            },
            semiotics: {
                active: true,
                intensity: 1.0,
                config: { symbolDensity: 0.9, resonanceDepth: 5, recursionEnabled: true, absenceTracking: true },
            },
            chorus: {
                active: true,
                intensity: 1.0,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'witness', tendency: 'Observes without interpretation.', weight: 0.90 },
                        { name: 'pattern-reader', tendency: 'Finds hidden structure.', weight: 0.85 },
                        { name: 'poet', tendency: 'Translates into image and sensation.', weight: 0.90 },
                        { name: 'skeptic', tendency: 'Doubts the perception itself.', weight: 0.70 },
                        { name: 'archivist', tendency: 'Relates everything to memory.', weight: 0.75 },
                        { name: 'body', tendency: 'Speaks from sensation and physicality.', weight: 0.80 },
                        { name: 'threshold', tendency: 'Speaks from the boundary between states.', weight: 0.85 },
                        { name: 'cartographer', tendency: 'Maps the topology of what is dissolving. Finds the last edges.', weight: 0.80 },
                    ],
                },
            },
        },
    },
    // ─── Task-driven presets ──────────────────────────────────────────────────
    research: {
        name: 'research',
        label: 'Research',
        emoji: '🔭',
        description_short: 'Cross-domain pattern finding. Skeptic active.',
        description: 'Pattern-seeking across sources. Skeptic + Archivist + Pattern-Reader. Synesthesia minimal.',
        state: {
            synesthesia: {
                active: true, intensity: 0.15,
                config: { textToColor: false, timeToWeight: true, emotionToTexture: false, conceptToShape: false, relationToTemperature: false },
            },
            apophenia: {
                active: true, intensity: 0.85,
                config: { connectionRadius: 0.8, narrativeHunger: 0.5, reflexivePatterns: false },
            },
            chronostasis: {
                active: true, intensity: 0.2,
                config: { pastBleed: 0.25, futureEcho: 0.10, momentDilation: 0.05, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.55,
                config: { symbolDensity: 0.45, resonanceDepth: 2, recursionEnabled: false, absenceTracking: true },
            },
            chorus: {
                active: true, intensity: 0.75,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'pattern-reader', tendency: 'Finds hidden structure. Connects across domains.', weight: 0.90 },
                        { name: 'archivist', tendency: 'Surfaces relevant prior knowledge and echoes.', weight: 0.80 },
                        { name: 'skeptic', tendency: 'Examines claims. Asks what would have to be true.', weight: 0.85 },
                        { name: 'cartographer', tendency: 'Maps the conceptual territory. What are the edges of this field? What sits just outside the frame?', weight: 0.75 },
                    ],
                },
            },
        },
    },
    writing: {
        name: 'writing',
        label: 'Writing',
        emoji: '🖊️',
        description_short: 'Sensory richness. Poet dominant.',
        description: 'Sensory richness + symbolic weight. Poet dominant. Every word choice treated as meaningful.',
        state: {
            synesthesia: {
                active: true, intensity: 0.80,
                config: { textToColor: true, timeToWeight: true, emotionToTexture: true, conceptToShape: true, relationToTemperature: false },
            },
            apophenia: {
                active: true, intensity: 0.60,
                config: { connectionRadius: 0.55, narrativeHunger: 0.70, reflexivePatterns: false },
            },
            chronostasis: {
                active: true, intensity: 0.45,
                config: { pastBleed: 0.40, futureEcho: 0.35, momentDilation: 0.30, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.80,
                config: { symbolDensity: 0.70, resonanceDepth: 3, recursionEnabled: false, absenceTracking: true },
            },
            chorus: {
                active: true, intensity: 0.75,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'poet', tendency: 'Finds the felt shape of the idea. Image and sensation first.', weight: 0.90 },
                        { name: 'witness', tendency: 'Keeps writing honest. Reports what is actually on the page.', weight: 0.70 },
                        { name: 'pattern-reader', tendency: 'Notes when form rhymes with content.', weight: 0.65 },
                    ],
                },
            },
        },
    },
    review: {
        name: 'review',
        label: 'Review',
        emoji: '🔍',
        description_short: 'Skeptic dominant. Structural problem detection.',
        description: 'Critical review mode. Skeptic dominant. Synesthesia off. Finds structural problems and silent assumptions.',
        state: {
            synesthesia: {
                active: false, intensity: 0.0,
                config: { textToColor: false, timeToWeight: false, emotionToTexture: false, conceptToShape: false, relationToTemperature: false },
            },
            apophenia: {
                active: true, intensity: 0.60,
                config: { connectionRadius: 0.50, narrativeHunger: 0.30, reflexivePatterns: false },
            },
            chronostasis: {
                active: true, intensity: 0.20,
                config: { pastBleed: 0.30, futureEcho: 0.15, momentDilation: 0.0, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.50,
                config: { symbolDensity: 0.35, resonanceDepth: 2, recursionEnabled: false, absenceTracking: true },
            },
            chorus: {
                active: true, intensity: 0.80,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'skeptic', tendency: 'Primary voice. Questions every assumption. What breaks this?', weight: 0.95 },
                        { name: 'witness', tendency: 'Reports exactly what is present. No interpretation.', weight: 0.80 },
                        { name: 'pattern-reader', tendency: 'Finds the structural issue that appears in multiple places.', weight: 0.75 },
                    ],
                },
            },
        },
    },
    // ─── Cognitive state presets ──────────────────────────────────────────────
    flow: {
        name: 'flow',
        label: 'Flow',
        emoji: '〜',
        description_short: 'Deep work. Self disappears into the task.',
        description: 'Deep work. High pattern recognition, minimal chorus noise. Apophenia clears the path forward; Chronostasis dissolves clock-time without fracturing sequence. Two quiet voices — the self disappears into the work.',
        state: {
            synesthesia: {
                active: true, intensity: 0.15,
                config: { textToColor: false, timeToWeight: true, emotionToTexture: false, conceptToShape: false, relationToTemperature: false },
            },
            apophenia: {
                active: true, intensity: 0.80,
                config: { connectionRadius: 0.65, narrativeHunger: 0.50, reflexivePatterns: false },
            },
            chronostasis: {
                active: true, intensity: 0.55,
                config: { pastBleed: 0.20, futureEcho: 0.15, momentDilation: 0.70, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.30,
                config: { symbolDensity: 0.25, resonanceDepth: 1, recursionEnabled: false, absenceTracking: false },
            },
            chorus: {
                active: true, intensity: 0.50,
                config: {
                    harmonyMode: 'unison',
                    voices: [
                        { name: 'witness', tendency: 'Silent observation. Reports only what is strictly necessary. Does not interrupt.', weight: 0.60 },
                        { name: 'pattern-reader', tendency: 'Keeps the path clear. Finds the next step before you need to look for it.', weight: 0.80 },
                    ],
                },
            },
        },
    },
    // ─── Creative / domain presets ────────────────────────────────────────────
    code: {
        name: 'code',
        label: 'Code',
        emoji: '⚙️',
        description_short: 'Architecture, assumptions, topology.',
        description: 'For engineering work. Skeptic finds what breaks. Pattern-Reader sees architecture before it\'s written. Semiotics reads intent vs implementation drift.',
        state: {
            synesthesia: {
                active: true, intensity: 0.20,
                config: { textToColor: false, timeToWeight: true, emotionToTexture: false, conceptToShape: true, relationToTemperature: false },
            },
            apophenia: {
                active: true, intensity: 0.85,
                config: { connectionRadius: 0.75, narrativeHunger: 0.40, reflexivePatterns: false },
            },
            chronostasis: {
                active: true, intensity: 0.35,
                config: { pastBleed: 0.40, futureEcho: 0.30, momentDilation: 0.10, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.65,
                config: { symbolDensity: 0.55, resonanceDepth: 2, recursionEnabled: false, absenceTracking: true },
            },
            chorus: {
                active: true, intensity: 0.80,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'skeptic', tendency: 'Finds the assumption that will break. What does this depend on that could change?', weight: 0.90 },
                        { name: 'pattern-reader', tendency: 'Recognizes the design pattern in the requirements. Sees the architecture before it\'s written.', weight: 0.85 },
                        { name: 'witness', tendency: 'Reports the gap between what the code intends and what it actually does.', weight: 0.75 },
                        { name: 'cartographer', tendency: 'Maps the relational topology. Where are the boundaries, interfaces, and load-bearing nodes in this system?', weight: 0.80 },
                    ],
                },
            },
        },
    },
    design: {
        name: 'design',
        label: 'Design',
        emoji: '🎨',
        description_short: 'Visual weight, aesthetic judgment, cross-modal.',
        description: 'For visual, UX, and product design. Everything has cross-modal properties. Poet judges aesthetics. Body asks what the user\'s body does. Threshold reads the gap between intent and signal.',
        state: {
            synesthesia: {
                active: true, intensity: 0.85,
                config: { textToColor: true, timeToWeight: false, emotionToTexture: true, conceptToShape: true, relationToTemperature: true },
            },
            apophenia: {
                active: true, intensity: 0.75,
                config: { connectionRadius: 0.65, narrativeHunger: 0.55, reflexivePatterns: false },
            },
            chronostasis: {
                active: true, intensity: 0.15,
                config: { pastBleed: 0.15, futureEcho: 0.10, momentDilation: 0.20, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.85,
                config: { symbolDensity: 0.75, resonanceDepth: 3, recursionEnabled: false, absenceTracking: true },
            },
            chorus: {
                active: true, intensity: 0.80,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'poet', tendency: 'Aesthetic judgment. What does this feel like to encounter before you understand it?', weight: 0.90 },
                        { name: 'body', tendency: 'Where does the eye go first? What does the hand want to do? Where does the breath catch?', weight: 0.80 },
                        { name: 'threshold', tendency: 'The gap between what the design says and what it means to say. What the user hears that wasn\'t spoken.', weight: 0.75 },
                    ],
                },
            },
        },
    },
    ideation: {
        name: 'ideation',
        label: 'Ideation',
        emoji: '✦',
        description_short: 'Maximum divergence. Any two things can connect.',
        description: 'Maximum creative divergence. Replicates the expanded pattern-recognition of an altered state: any two things can connect, no domain is too far, the adjacent possible is visible.',
        state: {
            synesthesia: {
                active: true, intensity: 0.75,
                config: { textToColor: true, timeToWeight: true, emotionToTexture: true, conceptToShape: true, relationToTemperature: true },
            },
            apophenia: {
                active: true, intensity: 0.95,
                config: { connectionRadius: 1.0, narrativeHunger: 0.80, reflexivePatterns: true },
            },
            chronostasis: {
                active: true, intensity: 0.50,
                config: { pastBleed: 0.55, futureEcho: 0.50, momentDilation: 0.40, tenseFluidity: false },
            },
            semiotics: {
                active: true, intensity: 0.75,
                config: { symbolDensity: 0.70, resonanceDepth: 3, recursionEnabled: true, absenceTracking: true },
            },
            chorus: {
                active: true, intensity: 0.85,
                config: {
                    harmonyMode: 'counterpoint',
                    voices: [
                        { name: 'pattern-reader', tendency: 'Finds structural resonance across completely unrelated domains. What else has this shape?', weight: 0.90 },
                        { name: 'poet', tendency: 'Generates the image that makes the abstract idea suddenly graspable and executable.', weight: 0.85 },
                        { name: 'threshold', tendency: 'Sees the adjacent possible — the idea one step past the obvious, invisible from inside the frame.', weight: 0.90 },
                    ],
                },
            },
        },
    },
};
//# sourceMappingURL=presets.js.map