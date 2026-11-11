/** The page of a server whose id the API has already authorized for this view. */
export const serverPath = (serverId: string): string => `/servers/${encodeURIComponent(serverId)}`

export const agentServerPath = serverPath

/** The form that adds a monitored host (a server, its agent and the token to install). */
export const NEW_SERVER_PATH = '/servers/new'
