/** The page of a server whose id the API has already authorized for this view. */
export const serverPath = (serverId: string): string => `/servers/${encodeURIComponent(serverId)}`

export const agentServerPath = serverPath
