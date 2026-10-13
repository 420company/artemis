/**
 * get_balance — READ-ONLY wallet balance lookup (WP-16).
 * Registry: permissionCategory 'read'. No funds move. No approval needed.
 *
 * GET /v1/wallet/balances?chain=…&address=…
 * Balances are relayed exactly as the gateway returns them. Nothing is
 * invented, estimated or recalculated.
 */
import type { AgentAction } from '../../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../types.js';
import {
  addressesEqual,
  asRecord,
  cleanText,
  contextSignal,
  displayToken,
  failure,
  invalidInput,
  normalizeAddress,
  normalizeChain,
  readField,
  resolvePlatformWallet,
  resolveZh,
  shortenAddress,
  t,
  walletFailure,
  walletRequest,
  type PlatformWalletConfig,
} from './walletConfig.js';

export const GET_BALANCE_DESCRIPTION = [
  '查询指定链上某个钱包地址的代币余额（只读操作，不会移动任何资金）。',
  '参数：chain（链标识，如 ethereum、base、solana），address（完整钱包地址）。',
  '余额数据来自平台钱包网关，请如实转述，不得编造或估算余额。',
  'Read-only: look up token balances for a wallet address on a given chain via the platform wallet gateway.',
  'Params: chain, address. Never invent or estimate balances; relay gateway errors as-is.',
].join(' ');

type GetBalanceAction = Extract<AgentAction, { type: 'get_balance' }>;

interface BalanceEntry {
  token: string;
  symbol: string;
  decimals: number;
  balance: string;
  balanceUsd?: string | undefined;
}

interface BalancesResponse {
  chain: string;
  address: string;
  balances: BalanceEntry[];
}

const MAX_DISPLAY_ENTRIES = 50;

function parseBalances(raw: unknown): BalancesResponse | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (typeof record.chain !== 'string' || typeof record.address !== 'string' || !Array.isArray(record.balances)) {
    return null;
  }

  const balances: BalanceEntry[] = [];
  for (const item of record.balances) {
    const entry = asRecord(item);
    if (
      !entry ||
      typeof entry.token !== 'string' ||
      typeof entry.symbol !== 'string' ||
      typeof entry.balance !== 'string' ||
      typeof entry.decimals !== 'number' ||
      !Number.isInteger(entry.decimals) ||
      entry.decimals < 0
    ) {
      return null;
    }
    if (entry.balanceUsd !== undefined && entry.balanceUsd !== null && typeof entry.balanceUsd !== 'string') {
      return null;
    }
    const parsed: BalanceEntry = {
      token: entry.token,
      symbol: entry.symbol,
      decimals: entry.decimals,
      balance: entry.balance,
    };
    if (typeof entry.balanceUsd === 'string' && entry.balanceUsd.trim()) parsed.balanceUsd = entry.balanceUsd.trim();
    balances.push(parsed);
  }

  return { chain: record.chain, address: record.address, balances };
}

function formatEntry(entry: BalanceEntry, zh: boolean): string {
  const label = entry.symbol.trim() ? cleanText(entry.symbol, 20) : displayToken(cleanText(entry.token, 100));
  const amount = cleanText(entry.balance, 80);
  const usd = entry.balanceUsd ? cleanText(entry.balanceUsd, 40) : undefined;
  if (zh) return `- ${label}：${amount}${usd ? `（≈ $${usd}）` : ''}`;
  return `- ${label}: ${amount}${usd ? ` (≈ $${usd})` : ''}`;
}

export async function executeGetBalance(
  action: GetBalanceAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const zh = resolveZh(action, context);

  const chain = normalizeChain(readField(action, 'chain'));
  if (!chain) {
    return {
      action,
      ...invalidInput(
        zh,
        'chain 必须是链标识，如 ethereum、base、solana。',
        'chain must be a chain identifier such as ethereum, base or solana.',
      ),
    };
  }
  const address = normalizeAddress(readField(action, 'address'));
  if (!address) {
    return {
      action,
      ...invalidInput(
        zh,
        'address 必须是完整的钱包地址（0x 开头的 40 位十六进制地址，或 base58 / bech32 地址）。',
        'address must be a full wallet address (0x + 40 hex chars, or a base58 / bech32 address).',
      ),
    };
  }

  let config: PlatformWalletConfig;
  try {
    config = await resolvePlatformWallet();
  } catch (error) {
    return { action, ...walletFailure(error, zh) };
  }

  let raw: unknown;
  try {
    raw = await walletRequest(config, '/wallet/balances', {
      query: { chain, address },
      signal: contextSignal(context),
    });
  } catch (error) {
    return { action, ...walletFailure(error, zh) };
  }

  const parsed = parseBalances(raw);
  if (!parsed) {
    return {
      action,
      ...failure(
        'failed',
        t(zh, '钱包网关返回的余额数据格式无效，无法展示余额。', 'The wallet gateway returned malformed balance data.'),
        'Malformed /wallet/balances response',
      ),
    };
  }
  if (parsed.chain.trim().toLowerCase() !== chain || !addressesEqual(parsed.address.trim(), address)) {
    return {
      action,
      ...failure(
        'failed',
        t(
          zh,
          '钱包网关返回的链或地址与查询不一致，已丢弃该结果。',
          'The wallet gateway returned balances for a different chain or address. The result was discarded.',
        ),
        'Balance response chain/address mismatch',
      ),
    };
  }

  const short = shortenAddress(address);
  const lines: string[] = [t(zh, `钱包余额 · ${chain} · ${short}`, `Wallet balances · ${chain} · ${short}`)];
  if (parsed.balances.length === 0) {
    lines.push(t(zh, '未查询到任何代币余额。', 'No token balances found.'));
  } else {
    for (const entry of parsed.balances.slice(0, MAX_DISPLAY_ENTRIES)) lines.push(formatEntry(entry, zh));
    const hidden = parsed.balances.length - MAX_DISPLAY_ENTRIES;
    if (hidden > 0) lines.push(t(zh, `…另有 ${hidden} 项未显示`, `…and ${hidden} more`));
  }
  lines.push(
    t(
      zh,
      '数据来自平台钱包网关，美元估值仅供参考。',
      'Data comes from the platform wallet gateway. USD values are informational only.',
    ),
  );

  return {
    action,
    ok: true,
    output: lines.join('\n'),
    data: { chain, address, balances: parsed.balances },
  };
}