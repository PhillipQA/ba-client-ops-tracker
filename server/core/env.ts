// Loads .env.local and .env before any module reads process.env.
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

dotenv.config()
