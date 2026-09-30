import { defineConfig } from 'prisma/config'
import { databaseUrl } from './src/databaseUrl'

const url = databaseUrl()
process.env.DATABASE_URL = url

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
})
