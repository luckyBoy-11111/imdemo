import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { io } from 'socket.io-client'
import { databaseUrl } from '../dist/databaseUrl.js'

const base = `http://127.0.0.1:${process.env.PORT ?? 3001}`
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } })
const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const accounts = [0, 1, 2].map((index) => ({ username: `test_${suffix}_${index}`, displayName: `测试用户${index}`, password: `T${randomUUID()}x` }))
const ids = []
const sockets = []
let conversationId

async function request(path, cookie, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, data: response.status === 204 ? null : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

async function connect(cookie) {
  const socket = io(base, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: false })
  sockets.push(socket)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
    setTimeout(() => reject(new Error('Socket 连接超时')), 5000)
  })
  return socket
}

function send(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit('message:send', payload, (error, result) => error ? reject(error) : resolve(result))
  })
}

async function run() {
  const unauthorized = await request('/conversations')
  assert.equal(unauthorized.status, 401)

  const registered = []
  for (const account of accounts) {
    const result = await request('/auth/register', undefined, 'POST', account)
    assert.equal(result.status, 201)
    ids.push(result.data.user.id)
    registered.push(result)
  }
  const [a, b, c] = registered
  const first = await request('/conversations', a.cookie, 'POST', { otherUserId: b.data.user.id })
  const duplicate = await request('/conversations', a.cookie, 'POST', { otherUserId: b.data.user.id })
  assert.equal(first.status, 201)
  assert.equal(first.data.conversation.id, duplicate.data.conversation.id)
  conversationId = first.data.conversation.id

  const deniedHistory = await request(`/conversations/${conversationId}/messages`, c.cookie)
  assert.equal(deniedHistory.status, 403)
  const socketA = await connect(a.cookie)
  const socketB = await connect(b.cookie)
  const socketC = await connect(c.cookie)
  const receivedByB = new Promise((resolve, reject) => {
    socketB.once('message:new', resolve)
    setTimeout(() => reject(new Error('实时消息接收超时')), 5000)
  })
  const clientMessageId = randomUUID()
  const payload = { conversationId, clientMessageId, content: '联调消息 😀' }
  const sent = await send(socketA, payload)
  assert.equal(sent.ok, true)
  assert.equal(sent.message.content, payload.content)
  assert.equal((await receivedByB).id, sent.message.id)
  const retried = await send(socketA, payload)
  assert.equal(retried.message.id, sent.message.id)
  assert.equal((await send(socketA, { ...payload, content: '不同内容' })).ok, false)
  assert.equal((await send(socketA, { conversationId, clientMessageId: randomUUID(), content: '   ' })).ok, false)
  const deniedSend = await send(socketC, { ...payload, clientMessageId: randomUUID() })
  assert.equal(deniedSend.ok, false)
  const deniedJoin = await new Promise((resolve) => socketC.emit('conversation:join', conversationId, resolve))
  assert.equal(deniedJoin.ok, false)

  const reply = await send(socketB, { conversationId, clientMessageId: randomUUID(), content: '收到' })
  assert.equal(reply.ok, true)
  const history = await request(`/conversations/${conversationId}/messages`, a.cookie)
  assert.deepEqual(history.data.messages.map((message) => message.id), [sent.message.id, reply.message.id])
  const later = await request(`/conversations/${conversationId}/messages?after=${sent.message.id}`, a.cookie)
  assert.deepEqual(later.data.messages.map((message) => message.id), [reply.message.id])
  const earlier = await request(`/conversations/${conversationId}/messages?before=${reply.message.id}`, a.cookie)
  assert.deepEqual(earlier.data.messages.map((message) => message.id), [sent.message.id])
  const count = await prisma.message.count({ where: { conversationId } })
  assert.equal(count, 2)
  for (let index = 0; index < 51; index++) {
    const result = await send(socketA, { conversationId, clientMessageId: randomUUID(), content: `分页消息 ${index}` })
    assert.equal(result.ok, true)
  }
  const newestPage = await request(`/conversations/${conversationId}/messages`, a.cookie)
  assert.equal(newestPage.data.messages.length, 50)
  assert.equal(newestPage.data.hasMore, true)
  const olderPage = await request(`/conversations/${conversationId}/messages?before=${newestPage.data.messages[0].id}`, a.cookie)
  assert.equal(olderPage.data.messages.length, 3)
  assert.equal(olderPage.data.hasMore, false)
  const recovered = await request(`/conversations/${conversationId}/messages?after=${sent.message.id}`, b.cookie)
  assert.equal(recovered.data.messages.length, 50)
  assert.equal(recovered.data.hasMore, true)

  const logout = await request('/auth/logout', a.cookie, 'POST')
  assert.equal(logout.status, 204)
  assert.equal((await request('/auth/me', a.cookie)).status, 401)
  assert.equal(socketA.connected, false)
  console.log('集成验证通过：注册与退出、鉴权、会话唯一性、实时收发、重试去重、历史分页、断线补拉接口及越权拦截')
}

try {
  await run()
} finally {
  for (const socket of sockets) socket.disconnect()
  if (conversationId) await prisma.conversation.deleteMany({ where: { id: conversationId } })
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
}
