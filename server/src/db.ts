import { PrismaClient } from '@prisma/client'
import { databaseUrl } from './databaseUrl.js'

export const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } })
