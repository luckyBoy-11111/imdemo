import { createHash, randomBytes } from 'node:crypto'
import { parse as parseCookie, serialize } from 'cookie'
import type { Request, RequestHandler, Response } from 'express'
import { prisma } from './db.js'
import { HttpError } from './errors.js'

const COOKIE_NAME = 'im_session'
const SESSION_DAYS = 7

export function sessionToken(request: { headers: { cookie?: string } }): string | undefined {
  return parseCookie(request.headers.cookie ?? '')[COOKIE_NAME]
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function userFromToken(token: string | undefined) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: { select: { id: true, username: true, displayName: true } } },
  })
  return session && session.expiresAt > new Date() ? session.user : null
}

export async function createSession(userId: string, response: Response): Promise<void> {
  const token = randomBytes(32).toString('hex')
  await prisma.session.create({
    data: {
      id: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
    },
  })
  response.setHeader('Set-Cookie', serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  }))
}

export async function deleteSession(request: Request, response: Response): Promise<void> {
  const token = sessionToken(request)
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } })
  response.setHeader('Set-Cookie', serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  }))
}

declare global {
  namespace Express {
    interface Request {
      authUser?: { id: string; username: string; displayName: string }
    }
  }
}

export const requireAuth: RequestHandler = async (request, _response, next) => {
  try {
    const user = await userFromToken(sessionToken(request))
    if (!user) throw new HttpError(401, '请先登录')
    request.authUser = user
    next()
  } catch (error) {
    next(error)
  }
}

export function currentUser(request: Request) {
  if (!request.authUser) throw new HttpError(401, '请先登录')
  return request.authUser
}
