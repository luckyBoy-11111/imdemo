import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, '接口不存在'))
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({ error: error.issues[0]?.message ?? '请求参数错误' })
    return
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message })
    return
  }
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    response.status(400).json({ error: '请求 JSON 格式错误' })
    return
  }
  console.error(error)
  response.status(500).json({ error: '服务器暂时不可用' })
}
