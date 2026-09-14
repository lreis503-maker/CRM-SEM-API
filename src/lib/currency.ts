import { APP_LOCALE } from "@/i18n/locale";
/**
 * Currency — single source of truth for deal-value formatting and
 * the currency picker options.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 */

/** App-wide fallback when no account/deal currency is available. */
export const DEFAULT_CURRENCY = "USD";

export interface CurrencyOption {
  /** ISO-4217 code, e.g. "USD". Stored verbatim in the DB. */
  code: string;
  /** Human label for the dropdown, e.g. "US Dollar". */
  label: string;
  /** Symbol for compact display, e.g. "$". */
  symbol: string;
}

/**
 * The currencies offered in pickers. Codes must be valid ISO-4217 so
 * `Intl.NumberFormat` renders the right symbol/grouping. Extend this
 * list to offer more — nothing else needs to change.
 */
export const CURRENCIES: CurrencyOption[] = [
  { code: "USD", label: "Dólar americano", symbol: "$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "Libra esterlina", symbol: "£" },
  { code: "INR", label: "Rupia indiana", symbol: "₹" },
  { code: "AUD", label: "Dólar australiano", symbol: "A$" },
  { code: "CAD", label: "Dólar canadense", symbol: "C$" },
  { code: "BRL", label: "Real brasileiro", symbol: "R$" },
  { code: "JPY", label: "Iene japonês", symbol: "¥" },
  { code: "CNY", label: "Yuan chinês", symbol: "¥" },
  { code: "AED", label: "Dirham dos Emirados Árabes Unidos", symbol: "د.إ" },
  { code: "ZAR", label: "Rand sul-africano", symbol: "R" },
  { code: "NGN", label: "Naira nigeriana", symbol: "₦" },
  { code: "SGD", label: "Dólar de Singapura", symbol: "S$" },
  { code: "MXN", label: "Peso mexicano", symbol: "$" },
  { code: "COP", label: "Peso colombiano", symbol: "$" },
];

/**
 * Format a deal value as a currency string. Whole-number output
 * (no minor units) — deal values are tracked to the dollar across
 * the app. `currency` defaults to USD so callers with nothing better
 * stay safe, but pass the account/deal currency wherever known.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carries
 * NO DB CHECK (only `accounts.default_currency` does), so legacy
 * rows, imports, or hand-edited data can hold malformed values like
 * "United States". We never let that crash a render — on a bad code
 * we fall back to "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(APP_LOCALE, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(APP_LOCALE, {
      maximumFractionDigits: 0,
    }).format(amount)}`;
  }
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "$1.2M" / "€34.5k" / "₹900". Uses the currency's symbol from
 * CURRENCIES, falling back to the code when we don't carry a symbol.
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = CURRENCIES.find((c) => c.code === code)?.symbol ?? `${code} `;
  return `${symbol}${formatCompactNumber(value)}`;
}

/**
 * Compact number for tight spaces (chart tiles, legends): 1_234 → "1.2k",
 * 1_200_000 → "1.2M", 900 → "900". The unit-less core shared with
 * {@link formatCurrencyShort}.
 */
export function formatCompactNumber(value: number): string {
  const v = Number(value || 0);
  const decimal = (amount: number) => amount.toLocaleString(APP_LOCALE, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (v >= 1_000_000) return `${decimal(v / 1_000_000)}M`;
  if (v >= 1_000) return `${decimal(v / 1_000)}${APP_LOCALE === 'pt-BR' ? ' mil' : 'k'}`;
  return v.toLocaleString(APP_LOCALE, { maximumFractionDigits: 0 });
}
