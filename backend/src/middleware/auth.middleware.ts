import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { User } from '../models/User.model'
import { ApiError } from '../utils/apiError'
import { ApiResponse } from '../utils/apiResponse'

declare global {
  namespace Express {
    interface Request {
      user?: any
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(401, 'Authentication required')
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as { id: string }

    const user = await User.findById(decoded.id).select('-password')
    if (!user) {
      throw new ApiError(401, 'User not found')
    }

    if (!user.isActive) {
      throw new ApiError(401, 'Account is deactivated')
    }

    req.user = user
    next()
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json(ApiResponse.error('Invalid or expired token'))
    } else if (error instanceof ApiError) {
      res.status(error.statusCode).json(ApiResponse.error(error.message))
    } else {
      res.status(401).json(ApiResponse.error('Authentication failed'))
    }
  }
}

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json(ApiResponse.error('Authentication required'))
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json(ApiResponse.error('Access denied'))
    }

    next()
  }
}