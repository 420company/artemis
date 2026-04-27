/**
 * Weather tools — backed by wttr.in (free, no API key needed).
 *
 * wttr.in returns formatted weather data via plain HTTP. We query the JSON
 * endpoint for structured data and reformat for the brain.
 *
 * Examples:
 *   curl wttr.in/Bangkok?format=j1   → JSON with current + 3-day forecast
 *   curl wttr.in/Bangkok?format=3    → "Bangkok: ☀ +33°C"
 */

const WTTR_BASE = 'https://wttr.in';

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

export interface WeatherCurrentAction {
  type: 'weather_current';
  location: string;
}

export interface WeatherForecastAction {
  type: 'weather_forecast';
  location: string;
  days?: number; // 1-3
}

interface WttrJson {
  current_condition?: Array<{
    temp_C?: string;
    temp_F?: string;
    FeelsLikeC?: string;
    weatherDesc?: Array<{ value?: string }>;
    humidity?: string;
    windspeedKmph?: string;
    winddir16Point?: string;
    observation_time?: string;
  }>;
  weather?: Array<{
    date?: string;
    maxtempC?: string;
    mintempC?: string;
    avgtempC?: string;
    sunHour?: string;
    hourly?: Array<{
      time?: string;
      tempC?: string;
      weatherDesc?: Array<{ value?: string }>;
      chanceofrain?: string;
    }>;
  }>;
  nearest_area?: Array<{
    areaName?: Array<{ value?: string }>;
    country?: Array<{ value?: string }>;
    region?: Array<{ value?: string }>;
  }>;
}

async function fetchWttr(location: string): Promise<WttrJson | { error: string }> {
  try {
    const url = `${WTTR_BASE}/${encodeURIComponent(location)}?format=j1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'curl/8.0' }, // wttr.in serves text by default to non-curl
    });
    if (!resp.ok) {
      return { error: `wttr.in returned ${resp.status}` };
    }
    const json = (await resp.json()) as WttrJson;
    return json;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function formatLocation(json: WttrJson): string {
  const area = json.nearest_area?.[0];
  const name = area?.areaName?.[0]?.value;
  const region = area?.region?.[0]?.value;
  const country = area?.country?.[0]?.value;
  return [name, region, country].filter(Boolean).join(', ');
}

export async function executeWeatherCurrent(action: WeatherCurrentAction): Promise<ToolResult> {
  if (!action.location || action.location.trim().length === 0) {
    return {
      ok: false,
      output: '请提供城市名（例如 "Bangkok" 或 "上海"）',
      error: { code: 'invalid_location', message: 'location required' },
    };
  }
  const result = await fetchWttr(action.location);
  if ('error' in result) {
    return {
      ok: false,
      output: `天气查询失败：${result.error}`,
      error: { code: 'weather_api_error', message: result.error },
    };
  }
  const current = result.current_condition?.[0];
  if (!current) {
    return {
      ok: false,
      output: `没有 ${action.location} 的当前天气数据`,
      error: { code: 'no_data', message: 'empty response' },
    };
  }
  const desc = current.weatherDesc?.[0]?.value ?? '未知';
  const lines = [
    `📍 ${formatLocation(result)}`,
    `${desc} · ${current.temp_C}°C (${current.temp_F}°F)`,
    `体感 ${current.FeelsLikeC}°C · 湿度 ${current.humidity}% · 风 ${current.windspeedKmph}km/h ${current.winddir16Point ?? ''}`.trim(),
  ];
  if (current.observation_time) lines.push(`观测 ${current.observation_time}`);
  return { ok: true, output: lines.join('\n') };
}

export async function executeWeatherForecast(action: WeatherForecastAction): Promise<ToolResult> {
  if (!action.location || action.location.trim().length === 0) {
    return {
      ok: false,
      output: '请提供城市名',
      error: { code: 'invalid_location', message: 'location required' },
    };
  }
  const days = Math.max(1, Math.min(3, Math.floor(action.days ?? 3)));
  const result = await fetchWttr(action.location);
  if ('error' in result) {
    return {
      ok: false,
      output: `天气查询失败：${result.error}`,
      error: { code: 'weather_api_error', message: result.error },
    };
  }
  const forecast = (result.weather ?? []).slice(0, days);
  if (forecast.length === 0) {
    return {
      ok: false,
      output: `没有 ${action.location} 的预报数据`,
      error: { code: 'no_data', message: 'empty response' },
    };
  }
  const lines: string[] = [`📍 ${formatLocation(result)} — ${days}日预报`];
  for (const day of forecast) {
    const date = day.date ?? '?';
    const noon = day.hourly?.find((h) => h.time === '1200') ?? day.hourly?.[Math.floor((day.hourly?.length ?? 0) / 2)];
    const noonDesc = noon?.weatherDesc?.[0]?.value ?? '';
    const rain = noon?.chanceofrain ? ` · 降雨 ${noon.chanceofrain}%` : '';
    lines.push(`  ${date}: ${day.mintempC}°C ~ ${day.maxtempC}°C · ${noonDesc}${rain}`);
  }
  return { ok: true, output: lines.join('\n') };
}
