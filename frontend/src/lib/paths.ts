/** The page of the server an agent runs on, for a link the API has already authorized by giving its id. */
export const agentServerPath = (serverId: string): string =>
  `/servers/${encodeURIComponent(serverId)}`
