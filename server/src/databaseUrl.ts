import 'dotenv/config'

export function databaseUrl(): string {
  const username = process.env.MYSQL_USER
  const password = process.env.MYSQL_PASSWORD
  const host = process.env.MYSQL_HOST ?? '127.0.0.1'
  const port = Number(process.env.MYSQL_PORT ?? '3306')
  const database = process.env.MYSQL_DATABASE ?? 'simple_im'

  if (!username || !password) throw new Error('请在 server/.env 中配置 MYSQL_USER 和 MYSQL_PASSWORD')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_PORT 必须是有效端口号')
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('MYSQL_DATABASE 只能包含字母、数字和下划线')

  const url = new URL(`mysql://${host}:${port}/${database}`)
  url.username = username
  url.password = password
  url.searchParams.set('charset', 'utf8mb4')
  return url.toString()
}
