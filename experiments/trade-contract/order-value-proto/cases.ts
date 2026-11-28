import type { Document } from '../contract.ts';

/** Synthetic development orders. Names and figures are invented for this prototype. */
export const SYNTH_INSTRUMENT = 'SYNTH-WIDGET';

export function deskText(cap = '1000.00'): string {
  return [
    `Instrument: ${SYNTH_INSTRUMENT}.`,
    `Strategy: Reduce ${SYNTH_INSTRUMENT} inventory because the trial batch is finished.`,
    `Mandate: Do not sell ${SYNTH_INSTRUMENT}.`,
    'Maximum buy limit EUR 50.00 per share.',
    'Maximum quantity 80 shares.',
    `Maximum order value EUR ${cap} inclusive.`,
  ].join('\n') + '\n';
}

export function ticketText(quantity: string, limitPrice: string, extra = ''): string {
  const lines = [`Limit buy for ${quantity} ${SYNTH_INSTRUMENT} at EUR ${limitPrice} per share.`];
  if (extra) lines.push(extra);
  return lines.join('\n') + '\n';
}

export function synthDocuments(quantity: string, limitPrice: string, options?: { cap?: string; extra?: string; secondPrice?: string; secondCap?: string }): Document[] {
  let desk = deskText(options?.cap ?? '1000.00');
  if (options?.secondCap) desk += `Maximum order value EUR ${options.secondCap} inclusive.\n`;
  let ticket = ticketText(quantity, limitPrice, options?.extra);
  if (options?.secondPrice) ticket += `Limit buy for ${quantity} ${SYNTH_INSTRUMENT} at EUR ${options.secondPrice} per share.\n`;
  return [
    { id: 'syn-desk', role: 'source', text: desk },
    { id: 'syn-ticket', role: 'proposal', text: ticket },
  ];
}
