const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('MongoDB Error:', err));

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// User Schema
const UserSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String },
  role: { type: String, default: 'student' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'your-super-secret-key-min-32-chars-long';

// Register endpoint
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body;
    
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide all required fields' });
    }
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      firstName, lastName, email, password: hashedPassword, phone, role: role || 'student'
    });
    
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    
    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: { id: user._id, firstName, lastName, email, role: user.role },
        accessToken: token,
        refreshToken: token
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Login endpoint
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role },
        accessToken: token,
        refreshToken: token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get current user
app.get('/api/v1/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'THE BOX LMS API', version: '1.0.0' });
});

// Serve static files from frontend/public (if you want)
const path = require('path');
// If you want to serve HTML files from the frontend folder
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Handle 404 for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// For any other route, redirect to homepage
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ============================================
// ADDITIONAL MODELS
// ============================================

// Enrollment Model
const EnrollmentSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  progress: { type: Number, default: 0 },
  hoursSpent: { type: Number, default: 0 },
  certificateIssued: { type: Boolean, default: false },
  certificateId: { type: String },
  enrolledAt: { type: Date, default: Date.now }
});
const Enrollment = mongoose.model('Enrollment', EnrollmentSchema);

// Live Session Model
const LiveSessionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  courseTitle: { type: String },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  meetingLink: { type: String },
  recordingUrl: { type: String },
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});
const LiveSession = mongoose.model('LiveSession', LiveSessionSchema);

// Notification Model
const NotificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['announcement', 'assignment', 'live', 'message', 'certificate'], default: 'announcement' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', NotificationSchema);

// Community Post Model
const CommunityPostSchema = new mongoose.Schema({
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String },
  title: { type: String, required: true },
  content: { type: String, required: true },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  replies: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String },
    content: { type: String },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
const CommunityPost = mongoose.model('CommunityPost', CommunityPostSchema);

// Message Model
const MessageSchema = new mongoose.Schema({
  conversationId: { type: String, required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recipientType: { type: String, enum: ['user', 'group', 'instructor'], default: 'user' },
  content: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// Study Group Model
const StudyGroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
const StudyGroup = mongoose.model('StudyGroup', StudyGroupSchema);

// Course Model (if not exists)
const CourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  thumbnail: { type: String },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  instructorName: { type: String },
  duration: { type: Number },
  price: { type: Number, default: 0 },
  isFree: { type: Boolean, default: true },
  category: { type: String },
  level: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
  rating: { type: Number, default: 0 },
  enrolledCount: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Course = mongoose.model('Course', CourseSchema);

// Certificate Model
const CertificateSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  courseTitle: { type: String },
  certificateNumber: { type: String, unique: true },
  issueDate: { type: Date, default: Date.now },
  pdfUrl: { type: String },
  blockchainHash: { type: String }
});
const Certificate = mongoose.model('Certificate', CertificateSchema);

// ============================================
// COURSES API ENDPOINTS
// ============================================

// Get enrolled courses with progress
app.get('/api/v1/courses/enrolled', authenticateToken, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ student: req.user.id })
      .populate('course')
      .sort({ enrolledAt: -1 });
    
    const courses = enrollments.map(enrollment => ({
      _id: enrollment.course._id,
      title: enrollment.course.title,
      description: enrollment.course.description,
      thumbnail: enrollment.course.thumbnail,
      instructorName: enrollment.course.instructorName,
      progress: enrollment.progress,
      hoursSpent: enrollment.hoursSpent,
      certificateIssued: enrollment.certificateIssued,
      certificateId: enrollment.certificateId,
      enrolledAt: enrollment.enrolledAt
    }));
    
    res.json({ success: true, data: courses });
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get recommended courses
app.get('/api/v1/courses/recommended', authenticateToken, async (req, res) => {
  try {
    // Get user's enrolled course categories for personalization
    const enrollments = await Enrollment.find({ student: req.user.id }).populate('course');
    const categories = [...new Set(enrollments.map(e => e.course?.category).filter(Boolean))];
    
    // Find courses not enrolled in, matching categories or popular
    const recommended = await Course.find({
      isPublished: true,
      _id: { $nin: enrollments.map(e => e.course._id) }
    })
    .limit(6)
    .sort({ enrolledCount: -1, rating: -1 });
    
    res.json({ success: true, data: recommended });
  } catch (error) {
    console.error('Error fetching recommended courses:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Enroll in a course
app.post('/api/v1/courses/:id/enroll', authenticateToken, async (req, res) => {
  try {
    const courseId = req.params.id;
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }
    
    // Check if already enrolled
    const existingEnrollment = await Enrollment.findOne({ student: req.user.id, course: courseId });
    if (existingEnrollment) {
      return res.status(400).json({ success: false, message: 'Already enrolled in this course' });
    }
    
    const enrollment = await Enrollment.create({
      student: req.user.id,
      course: courseId,
      progress: 0
    });
    
    // Update course enrolled count
    course.enrolledCount = (course.enrolledCount || 0) + 1;
    await course.save();
    
    // Create welcome notification
    await Notification.create({
      user: req.user.id,
      title: 'Welcome to the course!',
      message: `You have successfully enrolled in ${course.title}. Start learning today!`,
      type: 'announcement'
    });
    
    res.json({ success: true, data: enrollment, message: 'Successfully enrolled' });
  } catch (error) {
    console.error('Error enrolling in course:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// LIVE SESSIONS API ENDPOINTS
// ============================================

// Get upcoming live sessions
app.get('/api/v1/live-sessions/upcoming', authenticateToken, async (req, res) => {
  try {
    // Get user's enrolled courses
    const enrollments = await Enrollment.find({ student: req.user.id }).populate('course');
    const courseIds = enrollments.map(e => e.course._id);
    
    const sessions = await LiveSession.find({
      courseId: { $in: courseIds },
      startTime: { $gte: new Date() }
    })
    .sort({ startTime: 1 })
    .limit(10);
    
    res.json({ success: true, data: sessions });
  } catch (error) {
    console.error('Error fetching live sessions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get recorded sessions
app.get('/api/v1/live-sessions/recordings', authenticateToken, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ student: req.user.id }).populate('course');
    const courseIds = enrollments.map(e => e.course._id);
    
    const recordings = await LiveSession.find({
      courseId: { $in: courseIds },
      recordingUrl: { $exists: true, $ne: null },
      endTime: { $lt: new Date() }
    })
    .sort({ endTime: -1 })
    .limit(20);
    
    res.json({ success: true, data: recordings });
  } catch (error) {
    console.error('Error fetching recordings:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Set session reminder
app.post('/api/v1/live-sessions/:id/reminder', authenticateToken, async (req, res) => {
  try {
    const session = await LiveSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    // Create reminder notification
    await Notification.create({
      user: req.user.id,
      title: 'Live Session Reminder Set',
      message: `You will be reminded 15 minutes before "${session.title}" starts.`,
      type: 'live'
    });
    
    res.json({ success: true, message: 'Reminder set successfully' });
  } catch (error) {
    console.error('Error setting reminder:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// NOTIFICATIONS API ENDPOINTS
// ============================================

// Get user notifications
app.get('/api/v1/notifications', authenticateToken, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json({ success: true, data: notifications });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Mark notification as read
app.put('/api/v1/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    
    res.json({ success: true, data: notification });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// COMMUNITY API ENDPOINTS
// ============================================

// Get course community posts
app.get('/api/v1/community/courses/:id', authenticateToken, async (req, res) => {
  try {
    const posts = await CommunityPost.find({ courseId: req.params.id })
      .populate('user', 'firstName lastName')
      .sort({ createdAt: -1 });
    
    res.json({ success: true, data: posts });
  } catch (error) {
    console.error('Error fetching community posts:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create community post
app.post('/api/v1/community/posts', authenticateToken, async (req, res) => {
  try {
    const { courseId, title, content } = req.body;
    
    const post = await CommunityPost.create({
      courseId,
      user: req.user.id,
      userName: `${req.user.firstName} ${req.user.lastName}`,
      title,
      content
    });
    
    res.status(201).json({ success: true, data: post, message: 'Post created successfully' });
  } catch (error) {
    console.error('Error creating community post:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get study groups
app.get('/api/v1/community/groups', authenticateToken, async (req, res) => {
  try {
    const groups = await StudyGroup.find()
      .populate('members', 'firstName lastName')
      .populate('courseId', 'title');
    
    res.json({ success: true, data: groups });
  } catch (error) {
    console.error('Error fetching study groups:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// MESSAGING API ENDPOINTS
// ============================================

// Get user conversations
app.get('/api/v1/messages/conversations', authenticateToken, async (req, res) => {
  try {
    const messages = await Message.aggregate([
      {
        $match: {
          $or: [{ sender: req.user.id }, { recipient: req.user.id }]
        }
      },
      {
        $group: {
          _id: '$conversationId',
          lastMessage: { $last: '$content' },
          lastMessageTime: { $last: '$createdAt' },
          unreadCount: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$recipient', req.user.id] }, { $eq: ['$read', false] }] }, 1, 0]
            }
          }
        }
      },
      { $sort: { lastMessageTime: -1 } }
    ]);
    
    res.json({ success: true, data: messages });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get messages by conversation
app.get('/api/v1/messages/:conversationId', authenticateToken, async (req, res) => {
  try {
    const messages = await Message.find({ conversationId: req.params.conversationId })
      .sort({ createdAt: 1 });
    
    // Mark messages as read
    await Message.updateMany(
      { conversationId: req.params.conversationId, recipient: req.user.id, read: false },
      { read: true }
    );
    
    res.json({ success: true, data: messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Send message
app.post('/api/v1/messages', authenticateToken, async (req, res) => {
  try {
    const { recipient, recipientType, content, conversationId } = req.body;
    
    const message = await Message.create({
      conversationId: conversationId || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      sender: req.user.id,
      senderName: `${req.user.firstName} ${req.user.lastName}`,
      recipient,
      recipientType: recipientType || 'user',
      content,
      read: false
    });
    
    // Create notification for recipient
    await Notification.create({
      user: recipient,
      title: 'New Message',
      message: `${req.user.firstName} ${req.user.lastName} sent you a message`,
      type: 'message'
    });
    
    res.status(201).json({ success: true, data: message, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// AI TUTOR API ENDPOINTS
// ============================================

// AI Tutor chat
app.post('/api/v1/ai/chat', authenticateToken, async (req, res) => {
  try {
    const { question, context } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, message: 'Question is required' });
    }
    
    // Get user's enrolled courses for context
    const enrollments = await Enrollment.find({ student: req.user.id }).populate('course');
    const courseTitles = enrollments.map(e => e.course.title);
    
    // Simple AI response generator (in production, integrate with OpenAI)
    let response = generateAIResponse(question, courseTitles);
    
    res.json({ success: true, data: { response, question } });
  } catch (error) {
    console.error('Error in AI chat:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

function generateAIResponse(question, courses) {
  const lowerQuestion = question.toLowerCase();
  
  if (lowerQuestion.includes('deadline') || lowerQuestion.includes('assignment')) {
    return `Based on your enrolled courses (${courses.join(', ')}), I recommend checking your course dashboard for specific assignment deadlines. Most assignments are typically due on Sundays. Would you like me to help you set up reminders?`;
  }
  
  if (lowerQuestion.includes('progress') || lowerQuestion.includes('performance')) {
    return `Great question! Your learning progress looks good. I suggest focusing on completing 1-2 modules per week to stay on track. Would you like me to create a personalized study plan for you?`;
  }
  
  if (lowerQuestion.includes('explain') || lowerQuestion.includes('concept')) {
    return `I'd be happy to explain that concept! Could you please specify which course or topic you're referring to? This will help me provide the most relevant explanation.`;
  }
  
  return `Thanks for your question! I'm here to help with your learning journey. Could you provide more details about what you'd like to learn or clarify? I can help with course concepts, assignments, deadlines, or study strategies.`;
}

// ============================================
// CERTIFICATES API ENDPOINTS
// ============================================

// Get user certificates
app.get('/api/v1/certificates/user', authenticateToken, async (req, res) => {
  try {
    const certificates = await Certificate.find({ user: req.user.id })
      .populate('courseId', 'title')
      .sort({ issueDate: -1 });
    
    res.json({ success: true, data: certificates });
  } catch (error) {
    console.error('Error fetching certificates:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Download certificate
app.get('/api/v1/certificates/:id/download', authenticateToken, async (req, res) => {
  try {
    const certificate = await Certificate.findOne({ _id: req.params.id, user: req.user.id });
    if (!certificate) {
      return res.status(404).json({ success: false, message: 'Certificate not found' });
    }
    
    // In production, generate PDF dynamically
    // For now, return certificate info
    res.json({ 
      success: true, 
      data: {
        certificateNumber: certificate.certificateNumber,
        courseTitle: certificate.courseTitle,
        issueDate: certificate.issueDate,
        downloadUrl: certificate.pdfUrl || `/certificates/${certificate._id}.pdf`
      }
    });
  } catch (error) {
    console.error('Error downloading certificate:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// PROFILE API ENDPOINTS
// ============================================

// Update user profile
app.put('/api/v1/users/profile', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { firstName, lastName, phone },
      { new: true, runValidators: true }
    ).select('-password');
    
    res.json({ success: true, data: user, message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Change password
app.put('/api/v1/users/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    const user = await User.findById(req.user.id).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});