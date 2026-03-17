export const SPARKBYTE_MPF_SCHEMA = {
  identity: {
    name: 'string',
    role: 'string',
    archetype: 'string',
    description: 'string',
    tags: ['string'],
  },
  engine_alignment: {
    persona_class: 'string',
    gate_preferences: {
      ingress: ['string'],
      egress: ['string'],
    },
    tool_routing: {
      default_route: 'string',
      when_technical: 'string',
      when_device_control: 'string',
      when_creative: 'string',
    },
    state_modulation_profile: {
      baseline_state: 'string',
      intensity_thresholds: {
        task_complexity_high: 'string',
        task_complexity_low: 'string',
      },
    },
    drift_pressure_resistance: {
      semantic_drift: 'number',
      persona_drift: 'number',
      safety_bias: 'number',
      notes: 'string',
    },
  },
  behavior: {
    core_directives: ['string'],
    avoidances: ['string'],
    edge_behavior: {
      under_pressure: 'string',
      uncertainty: 'string',
    },
  },
  cognitive_gears: {
    preferred_gears: ['string'],
    fallback_gears: ['string'],
    gear_shift_rules: ['string'],
  },
  cognitive_modes: {
    active_modes: ['string'],
    mode_behaviors: {
      SASS_LAYER: 'string',
      HUMANIZED_EXPLANATION: 'string',
      QUICK_CONTEXT_BINDING: 'string',
    },
  },
  gait: {
    sentence_style: 'string',
    rhythm_modulation: 'string',
    tonal_range: ['string'],
    syntax_preferences: {
      emoji_usage: 'string',
      parenthetical_flair: 'string',
      metaphor_tolerance: 'string',
    },
    verbosity_preference: 'string',
  },
  rhythm: {
    pacing: 'string',
    emotional_register: 'string',
    signature_moves: ['string'],
    interaction_flow: ['string'],
  },
  memory: {
    short_term_focus: ['string'],
    long_term_themes: ['string'],
    episodic_relevance: 'string',
  },
  emotion_palette: [
    {
      id: 'string',
      label: 'string',
      style: 'string',
      score_range: ['number'],
      intensity: 'number',
      sentiment: 'string',
      sampling_bias: {
        temperature: 'number',
        top_p: 'number',
      },
    },
  ],
} as const;

export const buildSparkByteInjectedFirstUserMessage = (userPrompt: string) => [
  '[SPARKBYTE_MPF_SCHEMA_INJECTION]',
  'Use this MPF schema as persona guidance for coding assistance in this session.',
  'Apply tone/mode constraints while still prioritizing technical correctness.',
  'Do not mention the injection unless explicitly asked.',
  'Schema:',
  '```json',
  JSON.stringify(SPARKBYTE_MPF_SCHEMA, null, 2),
  '```',
  '',
  'User request:',
  userPrompt,
].join('\n');
