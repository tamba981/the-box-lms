import express from 'express'
import {
  register,
  login,
  refreshToken,
  logout,
  getMe,
  forgotPassword,
  resetPassword,
} from '../../controllers/auth.controller'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validation.middleware'
import { registerSchema, loginSchema } from '../../validations/auth.validation'

const router = express.Router()

router.post('/register', validate(registerSchema), register)
router.post('/login', validate(loginSchema), login)
router.post('/refresh-token', refreshToken)
router.post('/logout', authenticate, logout)
router.get('/me', authenticate, getMe)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)

export default router