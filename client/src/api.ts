export interface User { id: string; username: string; displayName: string }
export interface Message {
  id: number
  conversationId: string
  senderId: string
  clientMessageId: string
  content: string
  createdAt: string
}
export interface Conversation {
  id: string
  otherUser: User
  lastMessage: Message | null
  lastMessageAt: string
}
export interface MessagePage { messages: Message[]; hasMore: boolean }

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers },
    })
  } catch {
    throw new Error('网络连接失败，请稍后重试')
  }
  if (response.status === 204) return undefined as T
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : '请求失败'
    throw new Error(message)
  }
  return data as T
}
