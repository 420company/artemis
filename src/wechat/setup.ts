/**
 * wechat/setup.ts — WeChat (iLink) QR-code login flow.
 *
 * Handles the terminal setup flow for the WeChat bridge:
 *   GET /ilink/bot/get_bot_qrcode?bot_type=3      → qrcode key + URL
 *   GET /ilink/bot/get_qrcode_status?qrcode=<key> → wait / scaned / expired / confirmed
 *
 * No auth token is required for either request (this IS the login step).
 */

const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WECHAT_QR_POLL_TIMEOUT_MS = 37_000
const WECHAT_QR_MAX_REFRESH = 3
const WECHAT_DEFAULT_BOT_TYPE = '3'

type WeixinQRCodeResponse = {
  qrcode?: string
  qrcode_img_content?: string
}

type WeixinQRStatusResponse = {
  status?: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export type WeixinQRLoginResult = {
  token: string
  botId: string
  botBaseUrl: string
  userId: string
}

function normalizeBase(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim()
  return `${(trimmed || WECHAT_DEFAULT_BASE_URL).replace(/\/+$/, '')}/`
}

async function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`WeChat setup HTTP ${response.status}: ${raw.slice(0, 240)}`)
  }
  if (!raw.trim()) {
    return {}
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`WeChat setup invalid JSON response: ${raw.slice(0, 240)}`)
  }
}

async function fetchQRCode(
  base: string,
  botType: string,
  routeTag: string | undefined,
): Promise<WeixinQRCodeResponse> {
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`
  const headers: Record<string, string> = {}
  if (routeTag) {
    headers['SKRouteTag'] = routeTag
  }
  const raw = await httpGet(url, headers, 15_000)
  return raw as WeixinQRCodeResponse
}

async function pollQRStatus(
  base: string,
  qrKey: string,
  routeTag: string | undefined,
): Promise<WeixinQRStatusResponse> {
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrKey)}`
  const headers: Record<string, string> = {
    'iLink-App-ClientVersion': '1',
  }
  if (routeTag) {
    headers['SKRouteTag'] = routeTag
  }
  try {
    const raw = await httpGet(url, headers, WECHAT_QR_POLL_TIMEOUT_MS)
    return raw as WeixinQRStatusResponse
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { status: 'wait' }
    }
    throw error
  }
}

export async function runWeixinQRLogin(options: {
  baseUrl?: string
  routeTag?: string
  botType?: string
  timeoutSeconds?: number
  onStatus: (message: string) => void
  signal?: AbortSignal
}): Promise<WeixinQRLoginResult> {
  const base = normalizeBase(options.baseUrl)
  const botType = options.botType?.trim() || WECHAT_DEFAULT_BOT_TYPE
  const timeoutMs = (options.timeoutSeconds ?? 480) * 1_000
  const deadline = Date.now() + timeoutMs
  let refreshCount = 0

  const fetchAndDisplayQR = async (): Promise<string> => {
    const qrResp = await fetchQRCode(base, botType, options.routeTag)
    const qrKey = qrResp.qrcode?.trim()
    const qrUrl = qrResp.qrcode_img_content?.trim()
    if (!qrKey) {
      throw new Error('WeChat iLink returned empty qrcode key.')
    }
    if (!qrUrl) {
      throw new Error('WeChat iLink returned empty qrcode_img_content URL.')
    }
    options.onStatus(`QR URL: ${qrUrl}`)
    return qrKey
  }

  let qrKey = await fetchAndDisplayQR()
  let scannedNotified = false

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error('WeChat QR login aborted.')
    }

    const status = await pollQRStatus(base, qrKey, options.routeTag)

    switch (status.status) {
      case 'wait':
      case '':
      case undefined:
        options.onStatus('等待扫码中... / Waiting for QR scan...')
        await new Promise(r => setTimeout(r, 1_000))
        continue

      case 'scaned':
        if (!scannedNotified) {
          options.onStatus('已扫码，请在手机上确认登录 / Scanned — confirm login on your phone...')
          scannedNotified = true
        }
        await new Promise(r => setTimeout(r, 1_000))
        continue

      case 'expired':
        refreshCount++
        if (refreshCount > WECHAT_QR_MAX_REFRESH) {
          throw new Error('二维码多次过期，请重新运行配置 / QR code expired too many times. Re-run config.')
        }
        options.onStatus(`二维码过期，刷新中 (${refreshCount}/${WECHAT_QR_MAX_REFRESH})... / QR expired, refreshing...`)
        scannedNotified = false
        qrKey = await fetchAndDisplayQR()
        await new Promise(r => setTimeout(r, 1_000))
        continue

      case 'confirmed': {
        const token = status.bot_token?.trim()
        const botId = status.ilink_bot_id?.trim()
        if (!token) {
          throw new Error('WeChat login confirmed but bot_token is missing in response.')
        }
        if (!botId) {
          throw new Error('WeChat login confirmed but ilink_bot_id is missing in response.')
        }
        return {
          token,
          botId,
          botBaseUrl: status.baseurl?.trim() || base.replace(/\/$/, ''),
          userId: status.ilink_user_id?.trim() ?? '',
        }
      }

      default:
        await new Promise(r => setTimeout(r, 1_000))
        continue
    }
  }

  throw new Error('WeChat QR 登录超时，请重新运行配置 / WeChat QR login timed out. Re-run config.')
}
