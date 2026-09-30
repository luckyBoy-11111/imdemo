<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { api, type Conversation, type Message, type MessagePage, type User } from './api'

type PendingMessage = { conversationId: string; clientMessageId: string; content: string; status: 'sending' | 'failed'; error?: string; createdAt: string }
type ChatMessage = Message | PendingMessage

const me = ref<User | null>(null)
const loading = ref(true)
const authMode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const displayName = ref('')
const authBusy = ref(false)
const authError = ref('')
const notice = ref('')
const conversations = ref<Conversation[]>([])
const selectedId = ref<string | null>(null)
const messages = reactive<Record<string, Message[]>>({})
const pending = ref<PendingMessage[]>([])
const olderAvailable = reactive<Record<string, boolean>>({})
const historyBusy = ref(false)
const draft = ref('')
const connection = ref<'connecting' | 'online' | 'offline'>('offline')
const showPeople = ref(false)
const people = ref<User[]>([])
const peopleQuery = ref('')
const peopleBusy = ref(false)
const mobileChat = ref(false)
const messagePane = ref<HTMLElement | null>(null)
let socket: Socket | null = null
let selectionVersion = 0
let peopleSearchVersion = 0
const historyLoaded = new Set<string>()

const selected = computed(() => conversations.value.find((item) => item.id === selectedId.value) ?? null)
const visibleMessages = computed<ChatMessage[]>(() => {
  if (!selectedId.value) return []
  const saved = messages[selectedId.value] ?? []
  const savedIds = new Set(saved.map((item) => item.clientMessageId))
  return [...saved, ...pending.value.filter((item) => item.conversationId === selectedId.value && !savedIds.has(item.clientMessageId))]
})

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试'
}

function avatar(name: string): string { return name.trim().slice(0, 1).toUpperCase() || '?' }
function timeText(value: string): string {
  const date = new Date(value)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
function listTime(value: string): string {
  const date = new Date(value)
  const now = new Date()
  return date.toDateString() === now.toDateString() ? timeText(value) : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
function isSaved(message: ChatMessage): message is Message { return 'id' in message }
function isMine(message: ChatMessage): boolean { return !isSaved(message) || message.senderId === me.value?.id }
function initialsColor(value: string): string {
  const colors = ['#d9e7dc', '#f3dfcd', '#dce3f0', '#e8dded', '#e7e4cf']
  return colors[value.charCodeAt(0) % colors.length] ?? colors[0]!
}

async function refreshConversations(): Promise<void> {
  const result = await api<{ conversations: Conversation[] }>('/conversations')
  conversations.value = result.conversations
}

function mergeMessages(conversationId: string, incoming: Message[]): void {
  const byId = new Map<number, Message>()
  for (const item of messages[conversationId] ?? []) byId.set(item.id, item)
  for (const item of incoming) byId.set(item.id, item)
  messages[conversationId] = [...byId.values()].sort((a, b) => a.id - b.id)
  const incomingClientIds = new Set(incoming.map((item) => item.clientMessageId))
  pending.value = pending.value.filter((item) => !incomingClientIds.has(item.clientMessageId))
}

async function scrollBottom(): Promise<void> {
  await nextTick()
  if (messagePane.value) messagePane.value.scrollTop = messagePane.value.scrollHeight
}

async function selectConversation(id: string): Promise<void> {
  selectedId.value = id
  mobileChat.value = true
  const version = ++selectionVersion
  if (historyLoaded.has(id)) {
    await scrollBottom()
    return
  }
  historyBusy.value = true
  try {
    const page = await api<MessagePage>(`/conversations/${encodeURIComponent(id)}/messages`)
    mergeMessages(id, page.messages)
    olderAvailable[id] = page.hasMore
    historyLoaded.add(id)
    if (version === selectionVersion) await scrollBottom()
  } catch (error) {
    notice.value = errorText(error)
  } finally {
    if (version === selectionVersion) historyBusy.value = false
  }
}

async function loadOlder(): Promise<void> {
  const id = selectedId.value
  if (!id || historyBusy.value || !olderAvailable[id]) return
  const first = messages[id]?.[0]
  if (!first) return
  historyBusy.value = true
  const pane = messagePane.value
  const previousHeight = pane?.scrollHeight ?? 0
  try {
    const page = await api<MessagePage>(`/conversations/${encodeURIComponent(id)}/messages?before=${first.id}`)
    mergeMessages(id, page.messages)
    olderAvailable[id] = page.hasMore
    await nextTick()
    if (pane && selectedId.value === id) pane.scrollTop += pane.scrollHeight - previousHeight
  } catch (error) {
    notice.value = errorText(error)
  } finally {
    historyBusy.value = false
  }
}

async function syncMessages(id: string): Promise<void> {
  if (!historyLoaded.has(id)) return
  let cursor = messages[id]?.at(-1)?.id ?? 0
  while (true) {
    const page: MessagePage = await api<MessagePage>(`/conversations/${encodeURIComponent(id)}/messages?after=${cursor}`)
    if (!page.messages.length) break
    mergeMessages(id, page.messages)
    cursor = page.messages.at(-1)!.id
    if (!page.hasMore) break
  }
  if (selectedId.value === id) await scrollBottom()
}

async function syncAll(): Promise<void> {
  try {
    await refreshConversations()
    await Promise.all(Object.keys(messages).map(syncMessages))
  } catch (error) {
    notice.value = `补拉消息失败：${errorText(error)}`
  }
}

function connectSocket(): void {
  socket?.disconnect()
  connection.value = 'connecting'
  socket = io({ autoConnect: true, reconnection: true })
  socket.on('connect', () => {
    connection.value = 'online'
    void syncAll()
  })
  socket.on('disconnect', () => { connection.value = 'offline' })
  socket.on('connect_error', (error: Error) => {
    connection.value = 'offline'
    if (error.message === '请先登录') notice.value = '登录已失效，请刷新页面重新登录'
  })
  socket.on('message:new', (message: Message) => {
    mergeMessages(message.conversationId, [message])
    void refreshConversations().catch((error: unknown) => { notice.value = errorText(error) })
    if (selectedId.value === message.conversationId) void scrollBottom()
  })
}

async function submitAuth(): Promise<void> {
  authError.value = ''
  authBusy.value = true
  try {
    const result = await api<{ user: User }>(`/auth/${authMode.value}`, {
      method: 'POST',
      body: JSON.stringify({ username: username.value, password: password.value, ...(authMode.value === 'register' ? { displayName: displayName.value } : {}) }),
    })
    me.value = result.user
    password.value = ''
    await refreshConversations()
    if (conversations.value[0]) await selectConversation(conversations.value[0].id)
    connectSocket()
  } catch (error) {
    authError.value = errorText(error)
  } finally {
    authBusy.value = false
  }
}

async function logout(): Promise<void> {
  try {
    await api<void>('/auth/logout', { method: 'POST' })
    socket?.disconnect()
    socket = null
    me.value = null
    conversations.value = []
    selectedId.value = null
    pending.value = []
    for (const id of Object.keys(messages)) delete messages[id]
    historyLoaded.clear()
    connection.value = 'offline'
  } catch (error) {
    notice.value = errorText(error)
  }
}

async function searchPeople(): Promise<void> {
  const version = ++peopleSearchVersion
  peopleBusy.value = true
  try {
    const result = await api<{ users: User[] }>(`/users?q=${encodeURIComponent(peopleQuery.value)}`)
    if (version === peopleSearchVersion) people.value = result.users
  } catch (error) {
    notice.value = errorText(error)
  } finally {
    if (version === peopleSearchVersion) peopleBusy.value = false
  }
}

async function startConversation(userId: string): Promise<void> {
  try {
    const result = await api<{ conversation: { id: string } }>('/conversations', {
      method: 'POST', body: JSON.stringify({ otherUserId: userId }),
    })
    await refreshConversations()
    showPeople.value = false
    await selectConversation(result.conversation.id)
  } catch (error) {
    notice.value = errorText(error)
  }
}

function transmit(item: PendingMessage): void {
  if (!socket?.connected) {
    item.status = 'failed'
    item.error = '连接已中断'
    return
  }
  item.status = 'sending'
  item.error = undefined
  socket.timeout(10000).emit('message:send', {
    conversationId: item.conversationId,
    clientMessageId: item.clientMessageId,
    content: item.content,
  }, (error: Error | null, result: { ok: boolean; message?: Message; error?: string }) => {
    if (error || !result?.ok || !result.message) {
      item.status = 'failed'
      item.error = error ? '确认超时，请重试' : result?.error ?? '发送失败'
      return
    }
    mergeMessages(item.conversationId, [result.message])
    void refreshConversations().catch((refreshError: unknown) => { notice.value = errorText(refreshError) })
    void scrollBottom()
  })
}

function send(): void {
  const id = selectedId.value
  const content = draft.value.trim()
  if (!id || !content) return
  if (content.length > 2000) { notice.value = '消息不能超过 2000 字'; return }
  const item: PendingMessage = { conversationId: id, clientMessageId: crypto.randomUUID(), content, status: 'sending', createdAt: new Date().toISOString() }
  pending.value.push(item)
  draft.value = ''
  transmit(item)
  void scrollBottom()
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}

onMounted(async () => {
  try {
    const result = await api<{ user: User }>('/auth/me')
    me.value = result.user
    await refreshConversations()
    if (conversations.value[0]) await selectConversation(conversations.value[0].id)
    connectSocket()
  } catch (error) {
    if (errorText(error) !== '请先登录') notice.value = errorText(error)
  } finally {
    loading.value = false
  }
})
onUnmounted(() => { socket?.disconnect() })
</script>

<template>
  <div v-if="loading" class="boot-screen"><div class="brand-symbol">近</div><p>正在进入近语…</p></div>
  <main v-else-if="!me" class="auth-screen">
    <div class="auth-art">
      <div class="auth-orbit orbit-one"></div><div class="auth-orbit orbit-two"></div>
      <div class="auth-art-content"><span class="eyebrow">CLOSER, IN WORDS</span><h1>话很近，<br />人也很近。</h1><p>一个安静的地方，<br />留给每一句值得回应的话。</p></div>
      <div class="art-foot">近语 <span>—</span> 简单一点，聊得更近。</div>
    </div>
    <section class="auth-panel">
      <div class="auth-top"><span class="brand-mark">近</span><span class="brand-name">近语</span></div>
      <div class="auth-form-wrap">
        <div class="section-kicker">{{ authMode === 'login' ? 'WELCOME BACK' : 'JOIN THE CONVERSATION' }}</div>
        <h2>{{ authMode === 'login' ? '好久不见。' : '从一句你好开始。' }}</h2>
        <p class="muted">{{ authMode === 'login' ? '登录后，继续你们的对话。' : '创建账号，和朋友开始聊天。' }}</p>
        <form @submit.prevent="submitAuth">
          <label>账号<input v-model="username" autocomplete="username" placeholder="字母、数字或下划线" minlength="3" maxlength="32" required /></label>
          <label v-if="authMode === 'register'">展示名称<input v-model="displayName" autocomplete="nickname" placeholder="朋友会看到的名字" maxlength="40" required /></label>
          <label>密码<input v-model="password" type="password" :autocomplete="authMode === 'login' ? 'current-password' : 'new-password'" placeholder="至少 8 位" minlength="8" maxlength="72" required /></label>
          <p v-if="authError" class="form-error">{{ authError }}</p>
          <button class="primary-button auth-submit" :disabled="authBusy">{{ authBusy ? '请稍候…' : authMode === 'login' ? '进入近语' : '创建账号' }} <span>↗</span></button>
        </form>
        <p class="auth-switch">{{ authMode === 'login' ? '还没有账号？' : '已经有账号？' }} <button @click="authMode = authMode === 'login' ? 'register' : 'login'; authError = ''">{{ authMode === 'login' ? '立即注册' : '返回登录' }}</button></p>
      </div>
      <div class="auth-bottom">让对话，自然发生。</div>
    </section>
  </main>
  <main v-else class="app-shell">
    <aside class="sidebar" :class="{ 'mobile-hidden': mobileChat }">
      <header class="sidebar-header"><div class="brand-lockup"><span class="brand-mark">近</span><span class="brand-name">近语</span></div><button class="icon-button new-button" aria-label="发起新会话" title="发起新会话" @click="showPeople = true; searchPeople()">＋</button></header>
      <div class="sidebar-intro"><div><span class="section-kicker">YOUR CONVERSATIONS</span><h2>消息 <span>{{ conversations.length }}</span></h2></div><p>保持联系，从这里开始。</p></div>
      <div class="conversation-list">
        <button v-for="conversation in conversations" :key="conversation.id" class="conversation-row" :class="{ active: selectedId === conversation.id }" @click="selectConversation(conversation.id)">
          <span class="avatar" :style="{ background: initialsColor(conversation.otherUser.id) }">{{ avatar(conversation.otherUser.displayName) }}</span>
          <span class="conversation-copy"><span class="conversation-top"><strong>{{ conversation.otherUser.displayName }}</strong><time>{{ listTime(conversation.lastMessage?.createdAt ?? conversation.lastMessageAt) }}</time></span><span class="conversation-preview">{{ conversation.lastMessage?.content ?? '还没有消息，打个招呼吧' }}</span></span>
        </button>
        <div v-if="!conversations.length" class="empty-list"><div class="empty-glyph">✳</div><strong>这里还很安静</strong><p>发起一个新会话，让对话开始。</p><button @click="showPeople = true; searchPeople()">寻找聊天伙伴 ↗</button></div>
      </div>
      <footer class="sidebar-footer"><span class="self-avatar">{{ avatar(me.displayName) }}</span><span class="self-copy"><strong>{{ me.displayName }}</strong><small>@{{ me.username }}</small></span><button title="退出登录" aria-label="退出登录" class="logout-button" @click="logout">↪</button></footer>
    </aside>
    <section class="chat-panel" :class="{ 'mobile-hidden': !mobileChat }">
      <template v-if="selected">
        <header class="chat-header"><button class="back-button" aria-label="返回会话列表" @click="mobileChat = false">←</button><span class="avatar small" :style="{ background: initialsColor(selected.otherUser.id) }">{{ avatar(selected.otherUser.displayName) }}</span><div class="chat-person"><strong>{{ selected.otherUser.displayName }}</strong><span>@{{ selected.otherUser.username }}</span></div><div class="connection" :class="connection"><span class="connection-dot"></span>{{ connection === 'online' ? '已连接' : connection === 'connecting' ? '连接中' : '连接已断开' }}</div></header>
        <div ref="messagePane" class="message-pane" @scroll="(event) => { if ((event.target as HTMLElement).scrollTop < 80) loadOlder() }">
          <div class="conversation-start"><span class="start-icon">✳</span><p>你和 {{ selected.otherUser.displayName }} 的对话<br />从这里开始。</p></div>
          <div class="history-action"><button v-if="olderAvailable[selected.id]" :disabled="historyBusy" @click="loadOlder">{{ historyBusy ? '加载中…' : '查看更早的消息 ↑' }}</button></div>
          <div v-for="item in visibleMessages" :key="item.clientMessageId" class="message-row" :class="{ mine: isMine(item) }"><div class="message-bubble">{{ item.content }}</div><div class="message-meta"><time>{{ timeText(item.createdAt) }}</time><template v-if="isMine(item)"><span v-if="isSaved(item)">已发送</span><span v-else-if="item.status === 'sending'">发送中</span><button v-else class="retry-button" :title="item.error" @click="transmit(item)">发送失败 · 重试</button></template></div></div>
        </div>
        <div class="composer-wrap"><div class="composer"><textarea v-model="draft" rows="2" maxlength="2001" placeholder="写下你想说的话…" aria-label="消息内容" @keydown="onComposerKeydown"></textarea><button class="send-button" :disabled="!draft.trim()" aria-label="发送消息" @click="send">↗</button></div><div class="composer-hint"><span>按 Enter 发送 · Shift + Enter 换行</span><span>{{ draft.length }}/2000</span></div></div>
      </template>
      <div v-else class="blank-chat"><div class="blank-graphic"><span>✳</span></div><span class="section-kicker">A SPACE FOR WORDS</span><h2>每段对话，<br />都从这里开始。</h2><p>选择一个会话，或找一位朋友聊聊。</p><button class="primary-button" @click="showPeople = true; searchPeople()">发起新会话 ↗</button></div>
    </section>
    <div v-if="showPeople" class="modal-scrim" @click.self="showPeople = false"><div class="people-modal"><div class="modal-top"><div><span class="section-kicker">NEW CONVERSATION</span><h2>找个人聊聊。</h2></div><button class="icon-button" aria-label="关闭" @click="showPeople = false">×</button></div><input v-model="peopleQuery" class="people-search" placeholder="搜索账号或名字" aria-label="搜索用户" @input="searchPeople" /><div class="people-list"><p v-if="peopleBusy" class="list-note">正在查找…</p><p v-else-if="!people.length" class="list-note">没有找到其他用户</p><button v-for="person in people" :key="person.id" @click="startConversation(person.id)"><span class="avatar" :style="{ background: initialsColor(person.id) }">{{ avatar(person.displayName) }}</span><span><strong>{{ person.displayName }}</strong><small>@{{ person.username }}</small></span><span class="person-arrow">↗</span></button></div></div></div>
    <div v-if="notice" class="toast" role="alert">{{ notice }}<button aria-label="关闭提示" @click="notice = ''">×</button></div>
  </main>
</template>
