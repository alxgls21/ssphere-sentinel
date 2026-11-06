import { describe, expect, it } from 'vitest'
import { agentServerPath as networkAgentServerPath } from '@/features/network/networkModel'
import { agentServerPath as snmpAgentServerPath } from '@/features/snmp/snmpModel'
import { agentServerPath } from './paths'

describe('agentServerPath', () => {
  it('is one function, the one the Network and SNMP pages link with', () => {
    expect(networkAgentServerPath).toBe(agentServerPath)
    expect(snmpAgentServerPath).toBe(agentServerPath)
  })

  it('puts the id in one path segment, encoded', () => {
    expect(agentServerPath('srv-1')).toBe('/servers/srv-1')
    expect(agentServerPath('s/1?x#y')).toBe('/servers/s%2F1%3Fx%23y')
  })
})
