/**
 * Flight tracking tools — backed by AviationStack-free / OpenSky Network.
 *
 * For this build we go with **adsbdb.com** — public, no key, returns clean
 * JSON for callsigns + ICAO24 lookups. Falls back to OpenSky for live
 * position data.
 *
 * What works without an API key:
 *   - Aircraft info by callsign (e.g. "TG681") → registration, operator,
 *     aircraft type, photo
 *   - Live position via OpenSky's anonymous tier (state vectors)
 *
 * What we DON'T do here (would need paid keys):
 *   - Schedule/timetable (FlightAware, AviationStack require keys)
 *   - Historical flight tracks
 *
 * For the user's traveler use case ("am I on time? where's my flight now?"),
 * callsign + live position covers 80% of value.
 */

const ADSBDB_BASE = 'https://api.adsbdb.com/v0';
const OPENSKY_BASE = 'https://opensky-network.org/api';

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

export interface FlightLookupAction {
  type: 'flight_lookup';
  callsign: string; // e.g. "TG681", "EK385", "BA12"
}

interface AdsbdbAircraftResponse {
  response?: {
    aircraft?: {
      type?: string;
      icao_type?: string;
      manufacturer?: string;
      registered_owner?: string;
      registered_owner_country_name?: string;
      registered_owner_iata?: string;
      registered_owner_icao?: string;
      url_photo?: string;
    };
    flightroute?: {
      callsign?: string;
      callsign_iata?: string;
      airline?: { name?: string; iata?: string; icao?: string; country?: string };
      origin?: { name?: string; iata_code?: string; municipality?: string; country_iso_name?: string };
      destination?: { name?: string; iata_code?: string; municipality?: string; country_iso_name?: string };
    };
  };
}

interface OpenSkyState {
  // index-based state vector — see opensky-network.org/apidoc
  // [icao24, callsign, origin_country, time_position, last_contact,
  //  longitude, latitude, baro_altitude, on_ground, velocity, ...]
  states: Array<unknown[]>;
}

async function lookupAircraftInfo(callsign: string): Promise<AdsbdbAircraftResponse | { error: string }> {
  try {
    const url = `${ADSBDB_BASE}/callsign/${encodeURIComponent(callsign.toUpperCase())}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Artemis-CLI' } });
    if (!resp.ok) {
      if (resp.status === 404) return { error: 'callsign not found' };
      return { error: `HTTP ${resp.status}` };
    }
    return (await resp.json()) as AdsbdbAircraftResponse;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function lookupLivePosition(callsign: string): Promise<OpenSkyState | { error: string }> {
  try {
    // OpenSky doesn't query by callsign directly — we get all states and filter.
    // Anonymous tier is rate-limited but works for traveler use case.
    const resp = await fetch(`${OPENSKY_BASE}/states/all`, {
      headers: { 'User-Agent': 'Artemis-CLI' },
    });
    if (!resp.ok) return { error: `OpenSky HTTP ${resp.status}` };
    const json = (await resp.json()) as OpenSkyState;
    const target = callsign.toUpperCase().trim();
    const filtered = (json.states || []).filter((s) => {
      const cs = String(s[1] || '').toUpperCase().trim();
      return cs === target;
    });
    return { states: filtered };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function executeFlightLookup(action: FlightLookupAction): Promise<ToolResult> {
  if (!action.callsign || action.callsign.trim().length === 0) {
    return {
      ok: false,
      output: '请提供航班号（例如 "TG681"、"BA12"、"CA988"）',
      error: { code: 'invalid_input', message: 'callsign required' },
    };
  }
  const callsign = action.callsign.trim().toUpperCase();
  const [info, live] = await Promise.all([lookupAircraftInfo(callsign), lookupLivePosition(callsign)]);

  const lines: string[] = [`✈ 航班 ${callsign}`];

  if ('error' in info) {
    lines.push(`  航班资料：未找到 (${info.error})`);
  } else {
    const r = info.response?.flightroute;
    const a = info.response?.aircraft;
    if (r?.airline?.name) {
      lines.push(`  航司：${r.airline.name}${r.airline.country ? ` (${r.airline.country})` : ''}`);
    }
    if (r?.origin && r?.destination) {
      const o = r.origin;
      const d = r.destination;
      lines.push(`  路线：${o.iata_code ?? '?'} ${o.municipality ?? ''} → ${d.iata_code ?? '?'} ${d.municipality ?? ''}`);
    }
    if (a?.manufacturer || a?.type) {
      lines.push(`  机型：${[a.manufacturer, a.type].filter(Boolean).join(' ')}`);
    }
    if (a?.registered_owner) {
      lines.push(`  所属：${a.registered_owner}${a.registered_owner_country_name ? ` (${a.registered_owner_country_name})` : ''}`);
    }
  }

  if ('error' in live) {
    lines.push(`  实时位置：暂不可用 (${live.error})`);
  } else if (live.states.length === 0) {
    lines.push(`  实时位置：当前没有 ADS-B 信号（地面 / 信号盲区 / 已落地）`);
  } else {
    const s = live.states[0]!;
    const lon = s[5] as number | null;
    const lat = s[6] as number | null;
    const alt = s[7] as number | null;
    const onGround = s[8] as boolean;
    const vel = s[9] as number | null;
    const heading = s[10] as number | null;
    const country = s[2] as string;

    if (onGround) {
      lines.push(`  实时位置：在地面 · 国家 ${country}`);
    } else {
      const lonStr = typeof lon === 'number' ? lon.toFixed(3) : '?';
      const latStr = typeof lat === 'number' ? lat.toFixed(3) : '?';
      const altStr = typeof alt === 'number' ? `${Math.round(alt)}m (${Math.round(alt * 3.28084)}ft)` : '?';
      const velStr = typeof vel === 'number' ? `${Math.round(vel * 3.6)} km/h` : '?';
      const headStr = typeof heading === 'number' ? `${Math.round(heading)}°` : '?';
      lines.push(`  实时位置：${latStr}, ${lonStr}`);
      lines.push(`  高度 ${altStr} · 速度 ${velStr} · 航向 ${headStr} · 注册国 ${country}`);
    }
  }

  return { ok: true, output: lines.join('\n') };
}
