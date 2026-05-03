// Phosphene — Financial Lexicon
//
// A structured knowledge base for financial pattern recognition.
// Derived from FinGPT research (AI4Finance Foundation), quantitative
// finance methodology, and market microstructure literature.
//
// This is NOT a trading system. It is a perceptual layer:
// a set of structured lenses through which financial language
// becomes legible as pattern, emotion, and narrative.
//
// Markets are a sentiment aggregation engine.
// Price is crystalized collective emotion.
// News is the narrative layer over actual structure.
// The lexicon helps distinguish between them.

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The 7-point sentiment spectrum from FinGPT research.
 * More accurate than binary or ternary classification for financial text.
 * Maps positive integer values to bullish pressure, negative to bearish.
 */
export type FinancialSentimentGrade =
  | 'strong-negative'     // -3: Catastrophic. Bankruptcy, fraud, systemic failure.
  | 'moderate-negative'   // -2: Significant headwind. Missed earnings, guidance cut, legal exposure.
  | 'mild-negative'       // -1: Soft concern. Analyst downgrade, sector weakness, minor miss.
  | 'neutral'             //  0: Informational. No directional charge. Structural update.
  | 'mild-positive'       // +1: Soft tailwind. Modest beat, sector rotation in, minor upgrade.
  | 'moderate-positive'   // +2: Significant catalyst. Beat + raise, partnership, market share gain.
  | 'strong-positive';    // +3: Exceptional event. Breakout acquisition, transformative product, short squeeze.

/**
 * The six structural phases of a market cycle.
 * From RLSP research: price-aligned pattern detection across 620k+ headlines.
 */
export type MarketPhase =
  | 'accumulation'    // Low volatility, range-bound. Institutional quiet buying. No narrative yet.
  | 'markup'          // Trend emerging. Broad participation. Momentum building. Bull market onset.
  | 'distribution'    // Increased volatility. Failed breakouts. Late-cycle rotation. Invisible selling.
  | 'topping'         // Narrowing breadth. Divergences. Retail optimism peaks. Smart money exits.
  | 'markdown'        // Trend down. Bear structure. Fear-driven selling. News confirms the move.
  | 'bear-rally';     // Sharp, brief, poor breadth. Traps latecomers. Trend resumes lower.

/**
 * The source type of a financial signal.
 * Different sources carry different temporal weight and reliability.
 */
export type SignalSource =
  | 'price-action'    // The market itself speaking. Highest authority.
  | 'sec-filing'      // Legal document. Slow, precise, backward-looking.
  | 'earnings-call'   // Management tone + numbers. Qualitative + quantitative.
  | 'analyst-note'    // Consensus-forming. Lagging but market-moving.
  | 'news-wire'       // Fast. Often first. Context-poor.
  | 'social-media'    // Sentiment pulse. Noisy. Sometimes predictive.
  | 'insider-flow'    // Skin in the game. Slow-release signal, high conviction.
  | 'options-flow';   // Derivatives positioning. Forward-looking. Smart money proxy.

/**
 * A financial narrative archetype — the recurring story structures
 * that markets tell about companies. From FinGPT relation extraction
 * and market structure analysis.
 */
export type FinancialNarrativeType =
  | 'growth'          // Expanding TAM, market share capture, product velocity.
  | 'turnaround'      // Restructuring, new leadership, cost program, back from the edge.
  | 'disruption'      // New entrant attacking an incumbent's moat.
  | 'commodity-cycle' // Input cost pressure or pricing power plays.
  | 'regulatory'      // Moat via compliance barrier, or existential regulatory threat.
  | 'capital-allocation' // Buybacks, M&A, dividends — how management deploys cash.
  | 'contagion'       // One entity's crisis spreads: sector, counterparty, or correlation.
  | 'rerating';       // Multiple expansion/compression driven by perception shift, not fundamentals.

/**
 * Financial entity types. From FinGPT NER: Person, Organization, Location.
 * Extended with market-relevant subtypes.
 */
export type FinancialEntityType =
  | 'company'
  | 'sector'
  | 'index'
  | 'commodity'
  | 'currency'
  | 'rate-instrument'
  | 'regulator'
  | 'executive'
  | 'analyst'
  | 'fund';

/**
 * A single financial signal pattern — the atomic unit of detection.
 */
export interface FinancialSignalPattern {
  id: string;
  label: string;
  /** Keywords and phrases that indicate this signal. */
  triggers: string[];
  /** The sentiment grade this signal typically carries. */
  sentimentBias: FinancialSentimentGrade;
  /** How quickly this signal decays in relevance (in hours). */
  halfLifeHours: number;
  /** Which narrative types this signal is commonly part of. */
  narratives: FinancialNarrativeType[];
  /** Source reliability — how often this signal type is validated by price action. */
  signalQuality: 'high' | 'medium' | 'low' | 'context-dependent';
  /** The question this signal answers. The perceptual frame it opens. */
  coreQuestion: string;
}

/**
 * A market narrative — a story structure with its associated signals.
 */
export interface MarketNarrative {
  type: FinancialNarrativeType;
  label: string;
  description: string;
  /** Linguistic tells — phrases that signal this narrative is active. */
  linguisticSignals: string[];
  /** Typical duration in market time. */
  typicalDuration: string;
  /** What usually ends this narrative. */
  terminalCondition: string;
  /** The emotional arc the market experiences during this narrative. */
  emotionalArc: string;
  /** What a perceptive observer notices that others miss. */
  hiddenStructure: string;
}

/**
 * A matched result from financial lexicon detection.
 */
export interface FinancialLexiconMatch {
  signals: FinancialSignalPattern[];
  narratives: MarketNarrative[];
  sentimentGrade: FinancialSentimentGrade | null;
  dominantPhase: MarketPhase | null;
  entityMentions: Array<{ text: string; type: FinancialEntityType }>;
  /** The multi-agent synthesis — three analytical perspectives. */
  agentPerspectives: {
    researcher: string;   // What's the structural fact?
    analyst: string;      // What's the sentiment signal?
    advisor: string;      // What does this mean for positioning?
  } | null;
  /** Dissemination weight — how widely this content appears to have spread. */
  disseminationScore: number; // 0–1
}

// ─── Signal Patterns ──────────────────────────────────────────────────────────

const SIGNAL_PATTERNS: FinancialSignalPattern[] = [

  // ── Fundamental signals ───────────────────────────────────────────────────

  {
    id: 'earnings-beat',
    label: 'Earnings Beat',
    triggers: ['beat', 'beat estimates', 'beat expectations', 'exceeded', 'surpassed', 'topped', 'above consensus', 'beat analyst'],
    sentimentBias: 'moderate-positive',
    halfLifeHours: 48,
    narratives: ['growth', 'rerating'],
    signalQuality: 'context-dependent', // magnitude matters
    coreQuestion: 'By how much? And did guidance go up?',
  },
  {
    id: 'earnings-miss',
    label: 'Earnings Miss',
    triggers: ['miss', 'missed', 'fell short', 'below estimates', 'below expectations', 'disappointing quarter', 'consensus miss'],
    sentimentBias: 'moderate-negative',
    halfLifeHours: 72,
    narratives: ['turnaround', 'rerating'],
    signalQuality: 'context-dependent',
    coreQuestion: 'Is this structural or one-time? Did guidance change?',
  },
  {
    id: 'guidance-raise',
    label: 'Guidance Raise',
    triggers: ['raised guidance', 'raised outlook', 'increased guidance', 'raised full-year', 'raise forecast', 'boosted outlook', 'increased forecast'],
    sentimentBias: 'strong-positive',
    halfLifeHours: 96,
    narratives: ['growth', 'rerating'],
    signalQuality: 'high',
    coreQuestion: 'Management is more confident about the future than they were. Why now?',
  },
  {
    id: 'guidance-cut',
    label: 'Guidance Cut',
    triggers: ['cut guidance', 'lowered guidance', 'reduced guidance', 'warning', 'profit warning', 'lowered outlook', 'revised lower'],
    sentimentBias: 'strong-negative',
    halfLifeHours: 120,
    narratives: ['turnaround', 'commodity-cycle', 'rerating'],
    signalQuality: 'high',
    coreQuestion: 'What changed that management now sees? Demand, costs, or competition?',
  },
  {
    id: 'revenue-growth',
    label: 'Revenue Acceleration',
    triggers: ['revenue growth', 'revenue acceleration', 'top-line growth', 'sales growth', 'organic growth', 'double-digit growth'],
    sentimentBias: 'moderate-positive',
    halfLifeHours: 72,
    narratives: ['growth'],
    signalQuality: 'high',
    coreQuestion: 'Is this organic or acquisition-driven? Are margins expanding with it?',
  },
  {
    id: 'margin-compression',
    label: 'Margin Compression',
    triggers: ['margin pressure', 'compressed margins', 'margin contraction', 'gross margin declined', 'operating margin fell', 'cost inflation', 'input costs'],
    sentimentBias: 'moderate-negative',
    halfLifeHours: 48,
    narratives: ['commodity-cycle', 'rerating'],
    signalQuality: 'high',
    coreQuestion: 'Is this cyclical (passes) or structural (pricing power problem)?',
  },

  // ── Capital allocation signals ─────────────────────────────────────────────

  {
    id: 'buyback',
    label: 'Share Repurchase',
    triggers: ['buyback', 'share repurchase', 'repurchased shares', 'returned capital', 'stock repurchase program', 'bought back'],
    sentimentBias: 'mild-positive',
    halfLifeHours: 48,
    narratives: ['capital-allocation'],
    signalQuality: 'medium',
    coreQuestion: 'Is management buying because shares are cheap, or because they lack better uses of capital?',
  },
  {
    id: 'dividend',
    label: 'Dividend Action',
    triggers: ['dividend increase', 'dividend cut', 'dividend suspended', 'special dividend', 'dividend initiation', 'yield'],
    sentimentBias: 'neutral', // direction depends on increase/cut
    halfLifeHours: 120,
    narratives: ['capital-allocation'],
    signalQuality: 'medium',
    coreQuestion: 'Increase = confidence. Cut/suspension = distress signal. Which is this?',
  },
  {
    id: 'acquisition',
    label: 'M&A Activity',
    triggers: ['acquisition', 'acquired', 'merger', 'takeover', 'deal', 'buyout', 'purchased', 'agreed to buy', 'strategic acquisition'],
    sentimentBias: 'neutral', // acquirer often falls, target rises
    halfLifeHours: 240,
    narratives: ['capital-allocation', 'growth', 'rerating'],
    signalQuality: 'context-dependent',
    coreQuestion: 'Does this create or destroy value? Who holds the leverage in the deal?',
  },

  // ── Market structure signals ───────────────────────────────────────────────

  {
    id: 'short-squeeze',
    label: 'Short Squeeze',
    triggers: ['short squeeze', 'short interest', 'heavily shorted', 'covering shorts', 'short covering', 'gamma squeeze'],
    sentimentBias: 'strong-positive',
    halfLifeHours: 24, // short-lived
    narratives: ['rerating'],
    signalQuality: 'low', // momentum, not fundamental
    coreQuestion: 'Is this driven by fundamentals or positioning? What happens after the squeeze?',
  },
  {
    id: 'institutional-flow',
    label: 'Institutional Positioning',
    triggers: ['13F', 'disclosed stake', 'increased position', 'reduced position', 'activist investor', 'hedge fund', 'fund bought', 'fund sold', 'institutional buying'],
    sentimentBias: 'mild-positive',
    halfLifeHours: 72,
    narratives: ['capital-allocation', 'rerating'],
    signalQuality: 'medium',
    coreQuestion: 'Institutional buying is lagging (13F is 45 days old). What were they seeing then?',
  },
  {
    id: 'options-unusual',
    label: 'Unusual Options Activity',
    triggers: ['unusual options', 'unusual calls', 'large options', 'options volume', 'call sweep', 'put sweep', 'block trade'],
    sentimentBias: 'neutral', // direction depends on calls/puts
    halfLifeHours: 24,
    narratives: ['rerating'],
    signalQuality: 'context-dependent',
    coreQuestion: 'Smart money or hedging? Direction and expiry tell the story.',
  },

  // ── Macro and risk signals ─────────────────────────────────────────────────

  {
    id: 'rate-sensitivity',
    label: 'Interest Rate Impact',
    triggers: ['interest rate', 'federal reserve', 'fed', 'rate hike', 'rate cut', 'yield curve', 'basis points', 'monetary policy', 'central bank'],
    sentimentBias: 'neutral',
    halfLifeHours: 168, // a week
    narratives: ['commodity-cycle', 'rerating'],
    signalQuality: 'high',
    coreQuestion: 'Duration sensitivity: which sectors/assets benefit from this rate environment?',
  },
  {
    id: 'geopolitical',
    label: 'Geopolitical Risk',
    triggers: ['sanctions', 'tariff', 'trade war', 'supply chain disruption', 'conflict', 'geopolitical', 'export controls', 'ban', 'blockade'],
    sentimentBias: 'mild-negative',
    halfLifeHours: 336, // two weeks
    narratives: ['commodity-cycle', 'regulatory', 'contagion'],
    signalQuality: 'context-dependent',
    coreQuestion: 'Is this priced in? Who is the second-order beneficiary of this disruption?',
  },
  {
    id: 'regulatory-risk',
    label: 'Regulatory Threat',
    triggers: ['antitrust', 'investigation', 'subpoena', 'fine', 'penalty', 'regulatory', 'compliance', 'lawsuit', 'SEC investigation', 'DOJ', 'litigation'],
    sentimentBias: 'moderate-negative',
    halfLifeHours: 240,
    narratives: ['regulatory', 'contagion'],
    signalQuality: 'high',
    coreQuestion: 'What is the range of outcomes? Maximum fine vs. behavioral remedy vs. breakup?',
  },
  {
    id: 'contagion',
    label: 'Contagion Signal',
    triggers: ['contagion', 'spillover', 'sector-wide', 'industry-wide', 'systemic', 'counterparty risk', 'exposure', 'bank run', 'liquidity crisis'],
    sentimentBias: 'strong-negative',
    halfLifeHours: 48,
    narratives: ['contagion'],
    signalQuality: 'high',
    coreQuestion: 'What is the transmission mechanism? Where does it stop spreading?',
  },

  // ── Management and operational signals ────────────────────────────────────

  {
    id: 'leadership-change',
    label: 'Executive Change',
    triggers: ['CEO resigned', 'CEO appointed', 'CFO departure', 'management change', 'leadership transition', 'stepped down', 'named as CEO', 'appointed president'],
    sentimentBias: 'neutral',
    halfLifeHours: 96,
    narratives: ['turnaround', 'rerating'],
    signalQuality: 'context-dependent',
    coreQuestion: 'Forced exit (negative) or planned succession (neutral) or visionary hire (positive)?',
  },
  {
    id: 'layoff',
    label: 'Workforce Reduction',
    triggers: ['layoff', 'layoffs', 'job cuts', 'workforce reduction', 'restructuring', 'cost cutting', 'headcount reduction', 'downsizing', 'reorg'],
    sentimentBias: 'neutral', // can be negative (distress) or positive (efficiency)
    halfLifeHours: 48,
    narratives: ['turnaround', 'rerating'],
    signalQuality: 'context-dependent',
    coreQuestion: 'Is this reactive cost-cutting (weakness signal) or proactive efficiency (strength signal)?',
  },
  {
    id: 'product-launch',
    label: 'Product / Service Launch',
    triggers: ['launched', 'unveiled', 'announced', 'new product', 'new service', 'released', 'introduced', 'debut'],
    sentimentBias: 'mild-positive',
    halfLifeHours: 24,
    narratives: ['growth', 'disruption'],
    signalQuality: 'low', // hype vs. reality gap
    coreQuestion: 'Is this a revenue event or a narrative event? When does the revenue actually arrive?',
  },
  {
    id: 'insider-buying',
    label: 'Insider Buying',
    triggers: ['insider buying', 'insider purchased', 'director bought', 'executive purchased', 'form 4', 'open market purchase'],
    sentimentBias: 'moderate-positive',
    halfLifeHours: 240,
    narratives: ['turnaround', 'capital-allocation'],
    signalQuality: 'high',
    coreQuestion: 'Insiders sell for many reasons; they only buy for one. What do they know?',
  },
  {
    id: 'insider-selling',
    label: 'Insider Selling',
    triggers: ['insider selling', 'insider sold', 'director sold', 'executive sold', '10b5-1 plan', 'sold shares'],
    sentimentBias: 'mild-negative',
    halfLifeHours: 96,
    narratives: ['capital-allocation'],
    signalQuality: 'low', // often pre-planned, not necessarily bearish
    coreQuestion: 'Is this a 10b5-1 pre-plan (ignore) or discretionary (pay attention)?',
  },
];

// ─── Market Narratives ────────────────────────────────────────────────────────

const MARKET_NARRATIVES: MarketNarrative[] = [
  {
    type: 'growth',
    label: 'Growth Story',
    description: 'TAM expansion, market share capture, product velocity. The market believes the future is larger than the present.',
    linguisticSignals: ['total addressable market', 'market share', 'user growth', 'revenue acceleration', 'category leadership', 'secular tailwind'],
    typicalDuration: 'Months to years — ends when growth decelerates or valuation becomes untenable.',
    terminalCondition: 'Revenue growth misses consensus by >5%, or margin structure deteriorates at scale.',
    emotionalArc: 'Hope → Excitement → Euphoria → Denial → Capitulation',
    hiddenStructure: 'The growth premium in the multiple assumes the growth rate forever. The first deceleration is always a shock even when it was mathematically inevitable.',
  },
  {
    type: 'turnaround',
    label: 'Turnaround',
    description: 'Restructuring, new leadership, cost program. The market is pricing in change before it is visible in the numbers.',
    linguisticSignals: ['restructuring', 'new management', 'cost savings', 'streamlining', 'back to basics', 'operational improvement', 'self-help story'],
    typicalDuration: '12–36 months — full cycle from announcement to proof in earnings.',
    terminalCondition: 'Three consecutive quarters of improving margins and revenue stability. Or: failure to deliver triggers a second collapse.',
    emotionalArc: 'Disgust → Skepticism → Cautious Optimism → Belief',
    hiddenStructure: 'Turnarounds are priced before they are earned. The alpha is in identifying them before consensus does — not after the thesis is confirmed.',
  },
  {
    type: 'disruption',
    label: 'Disruption',
    description: 'A new entrant attacking an incumbent\'s moat. The attacker wins customers the incumbent didn\'t know it could lose.',
    linguisticSignals: ['disrupting', 'disruptive', 'incumbent', 'market share loss', 'pricing pressure', 'obsolescence', 'legacy', 'innovator\'s dilemma'],
    typicalDuration: 'Years — incumbents respond slowly.',
    terminalCondition: 'The incumbent either acquires the disruptor, pivots successfully, or loses the market.',
    emotionalArc: 'Disbelief → Dismissal → Panic → Capitulation (incumbent); Euphoria → Pullback → Consolidation (disruptor)',
    hiddenStructure: 'The disruption narrative usually moves faster in the stock market than in actual market share. The gap between narrative and reality is where the risk lives.',
  },
  {
    type: 'commodity-cycle',
    label: 'Commodity Cycle',
    description: 'Input cost pressure or pricing power plays. The company\'s fate is partly determined by factors outside its control.',
    linguisticSignals: ['commodity prices', 'input costs', 'raw materials', 'supply constraint', 'pricing power', 'pass-through', 'margin restoration'],
    typicalDuration: '3–18 months for input cost cycle.',
    terminalCondition: 'Commodity prices normalize, or company demonstrates pricing power to offset.',
    emotionalArc: 'Concern → Capitulation → Recovery → Complacency',
    hiddenStructure: 'The market tends to extrapolate commodity prices linearly — both on the way up (bearish for cost-exposed companies) and down (bullish). Mean reversion is usually faster than the market expects.',
  },
  {
    type: 'regulatory',
    label: 'Regulatory Event',
    description: 'Moat via compliance barrier, or existential regulatory threat. The government is a shareholder with different interests.',
    linguisticSignals: ['antitrust', 'regulatory approval', 'FDA approval', 'compliance', 'moat', 'barrier to entry', 'licensing', 'investigation'],
    typicalDuration: 'Months to years for large regulatory proceedings.',
    terminalCondition: 'Resolution — either approval (moat confirmed) or adverse ruling (structural constraint).',
    emotionalArc: 'Uncertainty → Anxiety → Relief or Distress',
    hiddenStructure: 'Regulatory narratives create binary outcomes that option markets price more accurately than stock markets. The stock often underreacts to tail risk because resolution is uncertain.',
  },
  {
    type: 'capital-allocation',
    label: 'Capital Allocation',
    description: 'How management deploys cash reveals what they believe about the company\'s future. Every capital decision is a vote on management\'s confidence.',
    linguisticSignals: ['buyback', 'acquisition', 'dividend', 'capex', 'return of capital', 'free cash flow', 'balance sheet', 'leverage'],
    typicalDuration: 'Ongoing — capital allocation quality compounds over years.',
    terminalCondition: 'Management changes philosophy, or capital runs out.',
    emotionalArc: 'Trust → Verification → Track record formation',
    hiddenStructure: 'The best capital allocators are boring. They buy back stock when it\'s cheap and sit on cash when everything is expensive. The market usually undervalues discipline because it requires patience to appreciate.',
  },
  {
    type: 'contagion',
    label: 'Contagion',
    description: 'One entity\'s crisis spreads through sector, counterparty, or correlation channels. Fear moves faster than information.',
    linguisticSignals: ['contagion', 'systemic risk', 'counterparty', 'exposure', 'spillover', 'correlated', 'sector-wide', 'domino'],
    typicalDuration: 'Days to weeks — acute phase. Recovery: weeks to months.',
    terminalCondition: 'Intervention (central bank, regulator), or the market identifies the boundary of the contagion.',
    emotionalArc: 'Surprise → Panic → Forced selling → Capitulation → Recovery',
    hiddenStructure: 'Contagion punishes correlation. Assets that were uncorrelated in normal markets discover hidden correlation under stress. The assets that fall most are often not the most fundamentally exposed — they are the most liquid.',
  },
  {
    type: 'rerating',
    label: 'Multiple Rerating',
    description: 'Perception shift drives valuation change independent of fundamentals. The multiple expands or contracts faster than earnings.',
    linguisticSignals: ['valuation', 'multiple', 'rerating', 'premium', 'discount', 'P/E', 'EV/EBITDA', 'sentiment shift', 'narrative change', 'repricing'],
    typicalDuration: 'Weeks to months for a compression; months to years for expansion.',
    terminalCondition: 'The new multiple is validated (or not) by earnings delivery.',
    emotionalArc: 'Narrative shift → Repositioning → Consensus formation → Locked in',
    hiddenStructure: 'Multiple expansion is the silent contributor to returns in bull markets. Most investors attribute it to earnings growth. In bear markets, multiple compression destroys value faster than earnings falls. The perception layer is doing most of the work.',
  },
];

// ─── Entity Detection ─────────────────────────────────────────────────────────

const ENTITY_PATTERNS: Array<{ pattern: RegExp; type: FinancialEntityType; label: string }> = [
  // Indices
  { pattern: /\b(S&P\s*500|SPX|Nasdaq|NDX|Dow\s*Jones|DJIA|Russell\s*2000|RUT)\b/i, type: 'index', label: 'Major Index' },
  // Rates
  { pattern: /\b(Treasury|T-bill|T-bond|yield|10-year|2-year|SOFR|LIBOR|fed funds)\b/i, type: 'rate-instrument', label: 'Rate Instrument' },
  // Commodities
  { pattern: /\b(crude oil|WTI|Brent|gold|silver|copper|natural gas|wheat|corn|soybeans)\b/i, type: 'commodity', label: 'Commodity' },
  // Currencies
  { pattern: /\b(USD|EUR|JPY|GBP|CNY|CHF|AUD|DXY|dollar index)\b/i, type: 'currency', label: 'Currency' },
  // Regulators
  { pattern: /\b(SEC|CFTC|Federal Reserve|Fed|ECB|BOJ|FCA|FINRA|DOJ|antitrust)\b/i, type: 'regulator', label: 'Regulator' },
  // Fund types
  { pattern: /\b(hedge fund|private equity|venture capital|ETF|mutual fund|pension fund)\b/i, type: 'fund', label: 'Fund Type' },
  // Executive titles
  { pattern: /\b(CEO|CFO|COO|CTO|president|chairman|board member)\b/i, type: 'executive', label: 'Executive' },
  // Analyst
  { pattern: /\b(analyst|strategist|portfolio manager|fund manager)\b/i, type: 'analyst', label: 'Analyst' },
  // Ticker-like (3-5 uppercase letters)
  { pattern: /\b([A-Z]{2,5})\b/g, type: 'company', label: 'Possible Ticker' },
];

// ─── Sentiment scoring ────────────────────────────────────────────────────────

const SENTIMENT_KEYWORDS: Array<{ words: string[]; grade: FinancialSentimentGrade }> = [
  { words: ['bankruptcy', 'fraud', 'collapse', 'default', 'insolvency', 'criminal', 'systemic failure', 'bank run'], grade: 'strong-negative' },
  { words: ['profit warning', 'guidance cut', 'missed earnings', 'investigation', 'fine', 'lawsuit', 'downgrade', 'below expectations'], grade: 'moderate-negative' },
  { words: ['slowing growth', 'margin pressure', 'headwind', 'concern', 'challenge', 'weak demand', 'slightly missed'], grade: 'mild-negative' },
  { words: ['in line with', 'as expected', 'unchanged', 'stable', 'neutral', 'reiterated', 'maintained'], grade: 'neutral' },
  { words: ['beat estimates', 'ahead of', 'outperformed', 'upgrade', 'positive outlook', 'modest beat'], grade: 'mild-positive' },
  { words: ['strong earnings', 'raised guidance', 'significantly beat', 'acquisition', 'strategic partnership', 'market share gain'], grade: 'moderate-positive' },
  { words: ['record earnings', 'transformative', 'breakthrough', 'dominant position', 'exceptional', 'blowout quarter'], grade: 'strong-positive' },
];

// ─── Dissemination scoring ────────────────────────────────────────────────────

/**
 * Estimate information dissemination weight.
 * Higher score = this information appears to have spread widely.
 * Based on FinGPT RLSP research: dissemination predicts market impact.
 */
function scoreDissemination(text: string): number {
  const t = text.toLowerCase();
  let score = 0.3; // base score

  // High-dissemination signals
  if (/\b(breaking|flash|urgent|developing)\b/.test(t)) score += 0.2;
  if (/\b(reuters|bloomberg|wsj|financial times|cnbc|ft\.com)\b/i.test(t)) score += 0.15;
  if (/\b(market-wide|sector-wide|industry-wide)\b/.test(t)) score += 0.2;
  if (/\b(trending|viral|widespread)\b/.test(t)) score += 0.15;

  // Lower-dissemination signals
  if (/\b(obscure|small-cap|microcap|illiquid|thinly traded)\b/i.test(t)) score -= 0.15;
  if (/\b(preliminary|unconfirmed|rumor|speculative)\b/.test(t)) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

// ─── Sentiment grading ────────────────────────────────────────────────────────

function gradeFinancialSentiment(text: string): FinancialSentimentGrade | null {
  const t = text.toLowerCase();
  const scores: Partial<Record<FinancialSentimentGrade, number>> = {};

  for (const { words, grade } of SENTIMENT_KEYWORDS) {
    for (const word of words) {
      if (t.includes(word)) {
        scores[grade] = (scores[grade] ?? 0) + 1;
      }
    }
  }

  const entries = Object.entries(scores) as Array<[FinancialSentimentGrade, number]>;
  if (entries.length === 0) return null;
  entries.sort(([, a], [, b]) => b - a);
  return entries[0]![0];
}

// ─── Phase detection ──────────────────────────────────────────────────────────

const PHASE_TRIGGERS: Array<{ phase: MarketPhase; keywords: string[] }> = [
  { phase: 'accumulation', keywords: ['range-bound', 'base building', 'low volume', 'consolidation', 'sideways', 'quiet'] },
  { phase: 'markup',       keywords: ['breakout', 'uptrend', 'new highs', 'broad participation', 'momentum', 'bull market', 'rally'] },
  { phase: 'distribution', keywords: ['distribution', 'failed breakout', 'churning', 'heavy volume', 'late cycle', 'rotation out'] },
  { phase: 'topping',      keywords: ['narrowing breadth', 'divergence', 'overbought', 'euphoria', 'frothy', 'stretched valuations', 'crowded trade'] },
  { phase: 'markdown',     keywords: ['downtrend', 'lower highs', 'bear market', 'selling pressure', 'declining', 'breakdown', 'waterfall'] },
  { phase: 'bear-rally',   keywords: ['bear market rally', 'short squeeze rally', 'oversold bounce', 'dead cat', 'relief rally', 'technical bounce'] },
];

function detectMarketPhase(text: string): MarketPhase | null {
  const t = text.toLowerCase();
  const hits: Record<MarketPhase, number> = {
    accumulation: 0, markup: 0, distribution: 0,
    topping: 0, markdown: 0, 'bear-rally': 0,
  };

  for (const { phase, keywords } of PHASE_TRIGGERS) {
    for (const kw of keywords) {
      if (t.includes(kw)) hits[phase]++;
    }
  }

  const best = Object.entries(hits).sort(([, a], [, b]) => b - a)[0]!;
  return best[1] > 0 ? (best[0] as MarketPhase) : null;
}

// ─── Entity extraction ────────────────────────────────────────────────────────

function extractEntities(text: string): Array<{ text: string; type: FinancialEntityType }> {
  const found: Array<{ text: string; type: FinancialEntityType }> = [];
  const seen = new Set<string>();

  for (const { pattern, type } of ENTITY_PATTERNS) {
    if (type === 'company') continue; // Ticker detection is noisy, skip
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      const key = `${type}:${match}`;
      if (!seen.has(key)) {
        found.push({ text: match, type });
        seen.add(key);
      }
    }
  }

  return found;
}

// ─── Multi-agent perspective synthesis ───────────────────────────────────────

function synthesizeAgentPerspectives(
  text: string,
  signals: FinancialSignalPattern[],
  grade: FinancialSentimentGrade | null,
  narratives: MarketNarrative[],
): FinancialLexiconMatch['agentPerspectives'] {
  if (signals.length === 0 && !grade) return null;

  const dominantSignal = signals[0];
  const dominantNarrative = narratives[0];

  const researcher = dominantSignal
    ? `${dominantSignal.label} detected. Core question: ${dominantSignal.coreQuestion}`
    : 'No high-confidence structural signal identified. Context-only input.';

  const gradeLabel = grade ?? 'undetermined';
  const analyst = `Sentiment grade: ${gradeLabel}.${dominantSignal ? ` Signal quality: ${dominantSignal.signalQuality}. Half-life: ${dominantSignal.halfLifeHours}h.` : ''}`;

  const advisor = dominantNarrative
    ? `Narrative context: ${dominantNarrative.type}. ${dominantNarrative.hiddenStructure}`
    : 'Insufficient narrative context for positioning guidance. Await confirming data.';

  return { researcher, analyst, advisor };
}

// ─── Main detection function ──────────────────────────────────────────────────

/**
 * Detect financial patterns, signals, and narratives in text.
 *
 * Applies the full financial lexicon:
 * - Signal pattern matching (earnings, guidance, flows, macro)
 * - 7-point FinGPT sentiment grading
 * - Market phase detection
 * - Entity extraction (indices, rates, commodities, regulators)
 * - Dissemination scoring
 * - Three-agent perspective synthesis
 */
export function detectFinancialPatterns(text: string): FinancialLexiconMatch {
  const t = text.toLowerCase();

  // Signal detection
  const matchedSignals = SIGNAL_PATTERNS.filter(signal =>
    signal.triggers.some(trigger => t.includes(trigger.toLowerCase()))
  );

  // Narrative detection
  const matchedNarratives = MARKET_NARRATIVES.filter(narrative =>
    narrative.linguisticSignals.some(sig => t.includes(sig.toLowerCase()))
  );

  // Sentiment grading
  const grade = gradeFinancialSentiment(text);

  // Phase detection
  const phase = detectMarketPhase(text);

  // Entity extraction
  const entities = extractEntities(text);

  // Dissemination score
  const dissemination = scoreDissemination(text);

  // Agent synthesis (only when signals found)
  const agentPerspectives = synthesizeAgentPerspectives(
    text, matchedSignals, grade, matchedNarratives
  );

  return {
    signals: matchedSignals,
    narratives: matchedNarratives,
    sentimentGrade: grade,
    dominantPhase: phase,
    entityMentions: entities,
    agentPerspectives,
    disseminationScore: dissemination,
  };
}

/**
 * Check if text has any financial content worth processing.
 * Fast pre-filter before running the full detection.
 */
export function hasFinancialContent(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(earnings|stock|market|shares|revenue|profit|loss|invest|trade|equity|bond|yield|fund|portfolio|analyst|valuation|dividend|acquisition|merger|ipo|nasdaq|nyse|s&p|dow|fed|treasury|commodity|currency)\b/.test(t);
}

/**
 * Get the core question this financial text is asking.
 * The meta-signal beneath the surface signals.
 */
export function extractCoreQuestion(match: FinancialLexiconMatch): string {
  if (match.signals.length > 0) {
    return match.signals[0]!.coreQuestion;
  }
  if (match.narratives.length > 0) {
    return `This is a ${match.narratives[0]!.type} narrative. ${match.narratives[0]!.hiddenStructure}`;
  }
  if (match.sentimentGrade) {
    return `Sentiment: ${match.sentimentGrade}. Verify: is this priced in?`;
  }
  return 'No dominant signal. The absence of signal is itself information.';
}

/**
 * Format a financial lexicon match for injection into AI context.
 * Used by apophenia and semiotics layers when financial content is detected.
 */
export function describeFinancialMatch(match: FinancialLexiconMatch): string {
  const lines: string[] = [];

  if (match.sentimentGrade) {
    lines.push(`[financial-sentiment: ${match.sentimentGrade}]`);
  }
  if (match.dominantPhase) {
    lines.push(`[market-phase: ${match.dominantPhase}]`);
  }
  if (match.signals.length > 0) {
    lines.push(`[signals: ${match.signals.map(s => s.label).join(', ')}]`);
    lines.push(`[core-question: ${match.signals[0]!.coreQuestion}]`);
  }
  if (match.narratives.length > 0) {
    lines.push(`[narratives: ${match.narratives.map(n => n.type).join(', ')}]`);
    lines.push(`[hidden-structure: ${match.narratives[0]!.hiddenStructure}]`);
  }
  if (match.agentPerspectives) {
    lines.push(`[researcher: ${match.agentPerspectives.researcher}]`);
    lines.push(`[analyst: ${match.agentPerspectives.analyst}]`);
    lines.push(`[advisor: ${match.agentPerspectives.advisor}]`);
  }
  if (match.entityMentions.length > 0) {
    lines.push(`[entities: ${match.entityMentions.map(e => `${e.text}(${e.type})`).join(', ')}]`);
  }
  lines.push(`[dissemination: ${Math.round(match.disseminationScore * 100)}%]`);

  return lines.join('\n');
}

export { SIGNAL_PATTERNS, MARKET_NARRATIVES };
