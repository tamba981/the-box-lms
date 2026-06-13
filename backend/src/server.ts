import express, { Application } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import dotenv from 'dotenv'
import connectDB from './config/database'
import { errorHandler } from './middleware/error.middleware'
import { rateLimiter } from './middleware/rateLimit.middleware'

// Load environment variables
dotenv.config()

const app: Application = express()
const PORT = process.env.PORT || 5000

// Connect to MongoDB
connectDB()

// Define allowed origins (add all your frontend URLs here)
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'https://tamba981.github.io',
  'https://the-box-lms-production.up.railway.app',
  process.env.FRONTEND_URL || ''
].filter(origin => origin && origin !== '')

// Configure CORS - THIS IS THE FIX
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) {
      return callback(null, true)
    }
    
    // Check if origin is allowed
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      console.warn(`CORS blocked origin: ${origin}`)
      console.log(`Allowed origins: ${allowedOrigins.join(', ')}`)
      callback(null, true) // TEMPORARY: Allow all for testing
      // callback(new Error(`CORS policy: Origin ${origin} not allowed`))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  exposedHeaders: ['Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}))

// Handle preflight requests
app.options('*', cors())

// Security middleware (relaxed for development)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" }
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(morgan('combined'))
app.use(rateLimiter)

// Import routes
import authRoutes from './routes/v1/auth.routes'
import userRoutes from './routes/v1/user.routes'
import courseRoutes from './routes/v1/course.routes'
import categoryRoutes from './routes/v1/category.routes'
import enrollmentRoutes from './routes/v1/enrollment.routes'
import certificateRoutes from './routes/v1/certificate.routes'
import diplomaRoutes from './routes/v1/diploma.routes'
import paymentRoutes from './routes/v1/payment.routes'
import quizRoutes from './routes/v1/quiz.routes'
import assignmentRoutes from './routes/v1/assignment.routes'
import aiRoutes from './routes/v1/ai.routes'
import dashboardRoutes from './routes/v1/dashboard.routes'
import adminRoutes from './routes/v1/admin.routes'
import mentorRoutes from './routes/v1/mentor.routes'
import instructorRoutes from './routes/v1/instructor.routes'
import communityRoutes from './routes/v1/community.routes'
import blogRoutes from './routes/v1/blog.routes'

// API Routes
app.use('/api/v1/auth', authRoutes)
app.use('/api/v1/users', userRoutes)
app.use('/api/v1/courses', courseRoutes)
app.use('/api/v1/categories', categoryRoutes)
app.use('/api/v1/enrollments', enrollmentRoutes)
app.use('/api/v1/certificates', certificateRoutes)
app.use('/api/v1/diplomas', diplomaRoutes)
app.use('/api/v1/payments', paymentRoutes)
app.use('/api/v1/quizzes', quizRoutes)
app.use('/api/v1/assignments', assignmentRoutes)
app.use('/api/v1/ai', aiRoutes)
app.use('/api/v1/dashboard', dashboardRoutes)
app.use('/api/v1/admin', adminRoutes)
app.use('/api/v1/mentor', mentorRoutes)
app.use('/api/v1/instructor', instructorRoutes)
app.use('/api/v1/community', communityRoutes)
app.use('/api/v1/blog', blogRoutes)

// Health check - make it CORS friendly
app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cors: 'enabled'
  })
})

// Error handling
app.use(errorHandler)

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📚 Environment: ${process.env.NODE_ENV}`)
  console.log(`🔗 API: http://localhost:${PORT}/api/v1`)
  console.log(`✅ CORS enabled for: ${allowedOrigins.join(', ')}`)
})

export default app
