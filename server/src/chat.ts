import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './db.js'
import { HttpError } from './errors.js'

export const sendSchema = z.object({
  conversationId: z.string().min(1),
  clientMessageId: z.string().uuid(),
  content: z.string().trim().min(1, '消息不能为空').max(2000, '消息不能超过 2000 字'),
})

const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  content: true,
  createdAt: true,
} satisfies Prisma.MessageSelect

export async function assertMember(conversationId: string, userId: string): Promise<void> {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  })
  if (!member) throw new HttpError(403, '无权访问此会话')
}

export async function listConversations(userId: string) {
  const rows = await prisma.conversation.findMany({
    where: { members: { some: { userId } } },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    include: {
      members: { include: { user: { select: { id: true, username: true, displayName: true } } } },
      messages: { orderBy: { id: 'desc' }, take: 1, select: messageSelect },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    otherUser: row.members.find((member) => member.userId !== userId)?.user,
    lastMessage: row.messages[0] ?? null,
    lastMessageAt: row.lastMessageAt,
  }))
}

export async function createConversation(userId: string, otherUserId: string) {
  if (userId === otherUserId) throw new HttpError(400, '不能与自己发起单聊')
  const other = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } })
  if (!other) throw new HttpError(404, '用户不存在')
  const directKey = [userId, otherUserId].sort().join(':')
  try {
    return await prisma.conversation.create({
      data: {
        directKey,
        members: { create: [{ userId }, { userId: otherUserId }] },
      },
      select: { id: true },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.conversation.findUnique({ where: { directKey }, select: { id: true } })
      if (existing) return existing
    }
    throw error
  }
}

export async function getMessages(conversationId: string, userId: string, before?: number, after?: number) {
  await assertMember(conversationId, userId)
  if (before !== undefined && after !== undefined) throw new HttpError(400, '不能同时指定前后游标')
  const messages = await prisma.message.findMany({
    where: { conversationId, ...(before !== undefined ? { id: { lt: before } } : {}), ...(after !== undefined ? { id: { gt: after } } : {}) },
    orderBy: { id: after !== undefined ? 'asc' : 'desc' },
    take: 51,
    select: messageSelect,
  })
  const hasMore = messages.length > 50
  const page = messages.slice(0, 50)
  return { messages: after !== undefined ? page : page.reverse(), hasMore }
}

export async function saveMessage(userId: string, raw: unknown) {
  const input = sendSchema.parse(raw)
  await assertMember(input.conversationId, userId)
  const existing = await prisma.message.findUnique({
    where: { senderId_clientMessageId: { senderId: userId, clientMessageId: input.clientMessageId } },
    select: messageSelect,
  })
  if (existing) {
    if (existing.conversationId !== input.conversationId || existing.content !== input.content) {
      throw new HttpError(409, '消息 ID 已用于其他内容')
    }
    return { message: existing, created: false }
  }
  try {
    const message = await prisma.$transaction(async (tx) => {
      const saved = await tx.message.create({
        data: { conversationId: input.conversationId, senderId: userId, clientMessageId: input.clientMessageId, content: input.content },
        select: messageSelect,
      })
      await tx.conversation.updateMany({
        where: { id: input.conversationId, lastMessageAt: { lt: saved.createdAt } },
        data: { lastMessageAt: saved.createdAt },
      })
      return saved
    })
    return { message, created: true }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const duplicate = await prisma.message.findUnique({
        where: { senderId_clientMessageId: { senderId: userId, clientMessageId: input.clientMessageId } },
        select: messageSelect,
      })
      if (duplicate && duplicate.conversationId === input.conversationId && duplicate.content === input.content) {
        return { message: duplicate, created: false }
      }
      throw new HttpError(409, '消息 ID 已用于其他内容')
    }
    throw error
  }
}
