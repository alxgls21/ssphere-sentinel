import type { SentinelApi } from '../client'
import type { AgentListOptions, AgentOption, AgentOptionList } from '../types'
import { parsePage } from './lists'
import { AGENT_STATUS, array, flag, nullableTime, oneOf, record, text, time } from './parse'
import { pageText, searchText } from './records'
import type { Transport } from './transport'

/**
 * The console API's agents (`agents/`): the agents of the servers the account may see, for choosing
 * which one probes a target or polls a device. Identity and state only: a token or a hash, were
 * one ever sent, is not read.
 */

export function parseAgentOption(raw: unknown): AgentOption {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    enabled: flag(row.enabled),
    status: oneOf(AGENT_STATUS, row.status),
    lastSeenAt: nullableTime(row.lastSeenAt),
    serverId: text(row.serverId),
    serverName: text(row.serverName),
  }
}

export function parseAgentOptionList(raw: unknown): AgentOptionList {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseAgentOption),
    page: parsePage(row.page),
  }
}

export const listAgents =
  (transport: Transport): SentinelApi['listAgents'] =>
  async (options: AgentListOptions = {}) =>
    parseAgentOptionList(
      await transport.get('agents/', {
        signal: options.signal,
        query: {
          q: searchText(options.q),
          page: pageText(options.page),
          pageSize: pageText(options.pageSize),
        },
      }),
    )
