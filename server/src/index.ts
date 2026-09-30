import 'dotenv/config'
import { createServer } from 'node:http'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import { Server } from 'socket.io'
import { z } from 'zod'
import { currentUser, createSession, deleteSession, hashToken, requireAuth, sessionToken, userFromToken } from './auth.js'
import { assertMember, createConversation, getMessages, listConversations, saveMessage } from './chat.js'
import { prisma } from './db.js'
import { errorHandler, HttpError, notFound } from './errors.js'

const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'
const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: clientOrigin, credentials: true }))
app.use(express.json({ limit: '16kb' }))
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: clientOrigin, credentials: true } })

const credentialsSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/, '账号须为 3–32 位小写字母、数字或下划线'),
  password: z.string().min(8, '密码至少 8 位').max(72, '密码不能超过 72 位'),
})

app.post('/api/auth/register', async (request, response) => {
  const input = credentialsSchema.extend({ displayName: z.string().trim().min(1).max(40) }).parse(request.body)
  const existing = await prisma.user.findUnique({ where: { username: input.username } })
  if (existing) throw new HttpError(409, '账号已存在')
  const user = await prisma.user.create({
    data: { username: input.username, displayName: input.displayName, passwordHash: await bcrypt.hash(input.password, 12) },
    select: { id: true, username: true, displayName: true },
  }).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') throw new HttpError(409, '账号已存在')
    throw error
  })
  await createSession(user.id, response)
  response.status(201).json({ user })
})

app.post('/api/auth/login', async (request, response) => {
  const input = credentialsSchema.parse(request.body)
  const user = await prisma.user.findUnique({ where: { username: input.username } })
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw new HttpError(401, '账号或密码错误')
  await createSession(user.id, response)
  response.json({ user: { id: user.id, username: user.username, displayName: user.displayName } })
})

app.post('/api/auth/logout', async (request, response) => {
  const token = sessionToken(request)
  await deleteSession(request, response)
  if (token) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionId === hashToken(token)) socket.disconnect(true)
    }
  }
  response.status(204).end()
})

app.get('/api/auth/me', requireAuth, (request, response) => {
  response.json({ user: currentUser(request) })
})

app.get('/api/users', requireAuth, async (request, response) => {
  const q = z.string().trim().max(40).parse(request.query.q ?? '')
  const users = await prisma.user.findMany({
    where: { id: { not: currentUser(request).id }, ...(q ? { OR: [{ username: { contains: q } }, { displayName: { contains: q } }] } : {}) },
    select: { id: true, username: true, displayName: true },
    orderBy: { username: 'asc' },
    take: 30,
  })
  response.json({ users })
})

app.get('/api/conversations', requireAuth, async (request, response) => {
  response.json({ conversations: await listConversations(currentUser(request).id) })
})

app.post('/api/conversations', requireAuth, async (request, response) => {
  const { otherUserId } = z.object({ otherUserId: z.string().min(1) }).parse(request.body)
  const conversation = await createConversation(currentUser(request).id, otherUserId)
  response.status(201).json({ conversation })
})

app.get('/api/conversations/:id/messages', requireAuth, async (request, response) => {
  const id = z.string().parse(request.params.id)
  const before = z.coerce.number().int().positive().optional().parse(request.query.before)
  const after = z.coerce.number().int().nonnegative().optional().parse(request.query.after)
  response.json(await getMessages(id, currentUser(request).id, before, after))
})

app.use(notFound)
app.use(errorHandler)

io.use(async (socket, next) => {
  try {
    const token = sessionToken(socket.request)
    const user = await userFromToken(token)
    if (!user || !token) return next(new Error('请先登录'))
    socket.data.userId = user.id
    socket.data.sessionId = hashToken(token)
    next()
  } catch (error) {
    console.error(error)
    next(new Error('身份验证失败'))
  }
})

io.on('connection', (socket) => {
  const userId = socket.data.userId as string
  socket.join(`user:${userId}`)
  socket.on('message:send', async (payload: unknown, ack?: (result: unknown) => void) => {
    try {
      const validUser = await userFromToken(sessionToken(socket.request))
      if (!validUser || validUser.id !== userId) throw new HttpError(401, '登录已失效')
      const { message, created } = await saveMessage(userId, payload)
      ack?.({ ok: true, message })
      if (created) {
        const members = await prisma.conversationMember.findMany({ where: { conversationId: message.conversationId }, select: { userId: true } })
        for (const member of members) io.to(`user:${member.userId}`).emit('message:new', message)
      }
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error(error)
      const reason = error instanceof HttpError ? error.message : error instanceof z.ZodError ? error.issues[0]?.message : '消息保存失败'
      ack?.({ ok: false, error: reason ?? '消息格式错误' })
    }
  })
  socket.on('conversation:join', async (conversationId: unknown, ack?: (result: unknown) => void) => {
    try {
      if (typeof conversationId !== 'string') throw new HttpError(400, '会话 ID 错误')
      const validUser = await userFromToken(sessionToken(socket.request))
      if (!validUser || validUser.id !== userId) throw new HttpError(401, '登录已失效')
      await assertMember(conversationId, userId)
      socket.join(`conversation:${conversationId}`)
      ack?.({ ok: true })
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error)
      ack?.({ ok: false, error: error instanceof HttpError ? error.message : '加入会话失败' })
    }
  })
})

const port = Number(process.env.PORT ?? 3001)
httpServer.listen(port, () => console.log(`IM server listening on ${port}`))

async function shutdown() {
  io.close()
  httpServer.close()
  await prisma.$disconnect()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
