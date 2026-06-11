import { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { User, IUser } from '../models/User.model'
import { sendEmail } from '../utils/sendEmail'
import { ApiResponse } from '../utils/apiResponse'
import { ApiError } from '../utils/apiError'

// Generate JWT tokens
const generateTokens = (userId: string, role: string) => {
  const accessToken = jwt.sign(
    { id: userId, role },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m' }
  )
  
  const refreshToken = jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
  )
  
  return { accessToken, refreshToken }
}

// Register user
export const register = async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body

    // Check if user exists
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      throw new ApiError(400, 'User already exists with this email')
    }

    // Create user
    const user = await User.create({
      firstName,
      lastName,
      email,
      password,
      phone,
      role: role || 'student',
    })

    // Generate email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex')
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`

    // Save verification token to user (you'd need a separate model for this)
    // For now, we'll just send the email

    // Send verification email
    await sendEmail({
      to: email,
      subject: 'Verify your email - The BOX',
      html: `
        <h1>Welcome to The BOX!</h1>
        <p>Please verify your email by clicking the link below:</p>
        <a href="${verificationUrl}">Verify Email</a>
      `,
    })

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user._id.toString(), user.role)

    res.status(201).json(ApiResponse.success({
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
      accessToken,
      refreshToken,
    }, 'Registration successful. Please verify your email.'))
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json(ApiResponse.error(error.message))
    } else {
      res.status(500).json(ApiResponse.error('Registration failed'))
    }
  }
}

// Login user
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    // Find user with password field
    const user = await User.findOne({ email }).select('+password')
    if (!user) {
      throw new ApiError(401, 'Invalid credentials')
    }

    // Check if account is locked
    if (user.lockUntil && user.lockUntil > new Date()) {
      throw new ApiError(401, 'Account is locked. Please try again later.')
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password)
    if (!isPasswordValid) {
      user.loginAttempts += 1
      
      if (user.loginAttempts >= 5) {
        user.lockUntil = new Date(Date.now() + 15 * 60 * 1000) // Lock for 15 minutes
      }
      
      await user.save()
      throw new ApiError(401, 'Invalid credentials')
    }

    // Reset login attempts
    user.loginAttempts = 0
    user.lockUntil = undefined
    user.lastLogin = new Date()
    await user.save()

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user._id.toString(), user.role)

    res.json(ApiResponse.success({
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
      accessToken,
      refreshToken,
    }, 'Login successful'))
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json(ApiResponse.error(error.message))
    } else {
      res.status(500).json(ApiResponse.error('Login failed'))
    }
  }
}

// Refresh token
export const refreshToken = async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body

    if (!refreshToken) {
      throw new ApiError(401, 'Refresh token required')
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { id: string }
    
    const user = await User.findById(decoded.id)
    if (!user) {
      throw new ApiError(401, 'Invalid refresh token')
    }

    // Generate new tokens
    const tokens = generateTokens(user._id.toString(), user.role)

    res.json(ApiResponse.success(tokens, 'Token refreshed'))
  } catch (error) {
    res.status(401).json(ApiResponse.error('Invalid refresh token'))
  }
}

// Logout
export const logout = async (req: Request, res: Response) => {
  // In a real implementation, you'd blacklist the token
  res.json(ApiResponse.success(null, 'Logged out successfully'))
}

// Get current user
export const getMe = async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.user?.id).select('-password')
    if (!user) {
      throw new ApiError(404, 'User not found')
    }

    res.json(ApiResponse.success(user))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to get user'))
  }
}

// Forgot password
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body

    const user = await User.findOne({ email })
    if (!user) {
      // Don't reveal that user doesn't exist
      return res.json(ApiResponse.success(null, 'If your email is registered, you will receive a reset link'))
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex')
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`

    // Save reset token to user (you'd need a separate model for this)

    // Send reset email
    await sendEmail({
      to: email,
      subject: 'Reset your password - The BOX',
      html: `
        <h1>Reset Your Password</h1>
        <p>Click the link below to reset your password:</p>
        <a href="${resetUrl}">Reset Password</a>
        <p>This link expires in 1 hour.</p>
      `,
    })

    res.json(ApiResponse.success(null, 'Password reset email sent'))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to send reset email'))
  }
}

// Reset password
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body

    // Verify token and find user (implementation depends on your token storage)
    // For now, we'll just send success

    res.json(ApiResponse.success(null, 'Password reset successful'))
  } catch (error) {
    res.status(500).json(ApiResponse.error('Failed to reset password'))
  }
}