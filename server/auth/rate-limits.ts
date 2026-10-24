// Sign-in and password-recovery limits.
import rateLimit from 'express-rate-limit'
import { createLoginLimiter } from './login-limiter'

export const loginLimiter = createLoginLimiter()

export const recoveryRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many recovery requests. Please try again in 15 minutes.' },
})

export const recoverySubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
})
