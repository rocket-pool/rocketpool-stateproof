import { SLOTS_PER_HISTORICAL_ROOT } from '@lodestar/params'

export type HistoricalNetwork = 'mainnet' | 'hoodi'

const HISTORY_START: Record<HistoricalNetwork, number> = {
  mainnet: 758,
  hoodi: 0
}

export interface HistoricalProofContext {
  historicalEntry: number
  historicalSlot: number
  slotIndex: number
}

export function isHistoricalNetwork(network: string): network is HistoricalNetwork {
  return network === 'mainnet' || network === 'hoodi'
}

export function getHistoricalProofContext(slot: number, network: HistoricalNetwork): HistoricalProofContext {
  const historicalPeriod = Math.floor(slot / SLOTS_PER_HISTORICAL_ROOT)

  return {
    historicalEntry: historicalPeriod - HISTORY_START[network],
    // The vectors summarized at a boundary contain roots through the preceding slot, so a slot exactly
    // on a boundary belongs to the summary created at the following boundary.
    historicalSlot: (historicalPeriod + 1) * SLOTS_PER_HISTORICAL_ROOT,
    slotIndex: slot % SLOTS_PER_HISTORICAL_ROOT
  }
}
