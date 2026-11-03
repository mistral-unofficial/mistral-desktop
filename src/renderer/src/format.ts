import type { AccountBudget } from '@shared/types'

const money = (n: number, locale?: string): string => n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function currencySymbol(currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency
  } catch {
    return currency
  }
}

/** Share of the budget used, as the label's value: "5%" (never a misleading "0%" while something is used). */
export function formatUsage(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

/** Amount spent so far, from the usage percentage and the initial budget: "0,44 / 8,50 €". */
export function formatBudget(b: AccountBudget, locale?: string): string {
  const spent = (b.initialBudget * b.usagePercent) / 100
  return `${money(spent, locale)} / ${money(b.initialBudget, locale)} ${currencySymbol(b.currency, locale)}`
}
