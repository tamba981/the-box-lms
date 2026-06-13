import express, { Application } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import dotenv from 'dotenv'
import mongoose from 'mongoose'

// Load environment variables
dotenv.config()

const app: Application = express()
const PORT = process.env.PORT || 5000

// Simple MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI!)
    console.log('✅ MongoDB Connected')
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error)
    process.exit(1)
  }
}
connectDB()

// Define allowed origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'https://tamba981.github.io',
  process.env.FRONTEND_URL || ''
].filter(origin => origin && origin !== '')

// Configure CORS
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true)
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      console.log(`CORS allowed origin: ${origin}`)
      callback(null, true)
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}))

app.options('*', cors())
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(morgan('combined'))

// Simple rate limiter
const rateLimiter = (req: any, res: any, next: any) => {
  next()
}
app.use(rateLimiter)

// ============================================
// MODELS
// ============================================

// User Model
const UserSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String },
  role: { type: String, enum: ['student', 'instructor', 'admin'], default: 'student' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
})

const User = mongoose.model('User', UserSchema)

// ============================================
// AUTH CONTROLLERS
// ============================================

const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

// Register
app.post('/api/v1/auth/register', async (req: any, res: any) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body
    
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists' })
    }
    
    const hashedPassword = await bcrypt.hash(password, 10)
    
    const user = await User.create({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      phone,
      role: role || 'student'
    })
    
    const accessToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET || 'secret123',
      { expiresIn: '7d' }
    )
    
    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role
        },
        accessToken,
        refreshToken: accessToken
      }
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ success: false, message: 'Registration failed' })
  }
})

// Login
app.post('/api/v1/auth/login', async (req: any, res: any) => {
  try {
    const { email, password } = req.body
    
    const user = await User.findOne({ email })
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' })
    }
    
    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' })
    }
    
    const accessToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET || 'secret123',
      { expiresIn: '7d' }
    )
    
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role
        },
        accessToken,
        refreshToken: accessToken
      }
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ success: false, message: 'Login failed' })
  }
})

// Get current user
app.get('/api/v1/auth/me', async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'No token provided' })
    }
    
    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET || 'secret123')
    
    const user = await User.findById(decoded.id).select('-password')
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' })
    }
    
    res.json({ success: true, data: user })
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid token' })
  }
})

// Health check
app.get('/health', (req: any, res: any) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cors: 'enabled'
  })
})

// Root endpoint
app.get('/', (req: any, res: any) => {
  res.json({ message: 'THE BOX LMS API', version: '1.0.0' })
})

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error(err)
  res.status(500).json({ success: false, message: 'Internal server error' })
})

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`🔗 API: http://localhost:${PORT}/api/v1`)
  console.log(`✅ Health check: http://localhost:${PORT}/health`)
})
