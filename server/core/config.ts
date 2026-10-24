// Server settings that come from the environment.
import './env'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = path.resolve(__dirname, '..', '..')

export const port = Number(process.env.PORT || 5173)

export const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production')

export const followUpTimeZone = process.env.FOLLOW_UP_TIME_ZONE || 'Asia/Manila'
